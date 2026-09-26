"""Managed, same-target Jev adapter. The upstream Agent remains the action loop."""
from __future__ import annotations
import contextlib
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time
import uuid
from bridge import BridgeError, Cancelled, cancelled, verify_connection, require_target

LIVE_STATE = Path(__file__).with_name("live-state.js").read_text().strip()

class Journal:
    def __init__(self, root: str, run_id: str):
        import re
        if not re.fullmatch(r"r_[a-f0-9]{32}", run_id):
            raise BridgeError("run", "Invalid run ID")
        self.directory = Path(root) / "runs" / run_id
        self.file = self.directory / "events.jsonl"
        self.meta = json.loads((self.directory / "task.json").read_text())
        if self.meta["version"] != 2 or self.meta["expiresAt"] < time.time() * 1000:
            raise BridgeError("expired", "Saved run is invalid or expired.")
    def events(self):
        raw = self.file.read_text()
        events = [json.loads(line) for line in raw.split("\n")[:-1] if line]
        if any(e["version"] != 1 or e["seq"] != i + 1 for i, e in enumerate(events)):
            raise BridgeError("journal", "Invalid event sequence.")
        return events
    def append(self, event_type, **data):
        events = self.events()
        raw = self.file.read_bytes()
        complete = raw.rfind(b"\n") + 1
        if complete != len(raw):
            with self.file.open("r+b") as f: f.truncate(complete)
        record = dict(version=1, seq=len(events)+1, at=round(time.time()*1000), type=event_type, data=data)
        fd = os.open(self.file, os.O_WRONLY | os.O_APPEND)
        try:
            with os.fdopen(fd, "a") as f:
                f.write(json.dumps(record, separators=(",", ":")) + "\n")
                f.flush(); os.fsync(f.fileno())
        except Exception:
            raise BridgeError("journal", "Cannot journal an action. Dispatch stopped.")
    def guard(self, category):
        parent = os.environ.get("FASTEST_E2E_CALLER_PID")
        if parent and os.getppid() != int(parent):
            raise BridgeError("cancelled", "The controlling process ended.")
        events = self.events()
        key, maximum = ("action.start", self.meta["task"].get("maxSteps", 30)) if category == "action" else ("call.start", self.meta["task"].get("maxModelCalls", 60))
        if sum(e["type"] == key for e in events) >= maximum:
            raise BridgeError("budget_exhausted", "The shared run budget is exhausted.")
    def save_field(self, key, value, source):
        file = self.directory / "recovery.json"
        values = json.loads(file.read_text()) if file.exists() else {}
        values[key] = dict(value=value, source=source, at=round(time.time()*1000))
        temporary = file.with_suffix(f".{uuid.uuid4().hex}.tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(values, f); f.flush(); os.fsync(f.fileno())
        os.replace(temporary, file)

def checkpoint(browser, journal):
    tree = browser.call("Page.getFrameTree")["frameTree"]
    def ids(t):
        return [t["frame"]["id"], t["frame"]["loaderId"], *[ids(c) for c in t.get("childFrames", [])]]
    document_id = hashlib.sha256(json.dumps(ids(tree), separators=(",", ":")).encode()).hexdigest()
    live = browser.evaluate(f"JSON.stringify({LIVE_STATE})")
    journal.append("checkpoint", documentId=document_id, fingerprint=hashlib.sha256(live.encode()).hexdigest(), url=json.loads(live)["url"])

def capture(browser, journal, action=None, text=None):
    task = journal.meta["task"]
    fields = task.get("recovery", {}).get("fields", [])
    if not fields:
        return
    steps = [*task.get("steps", []), *task.get("recovery", {}).get("reconstruct", [])]
    events = journal.events()
    # A scoped secret fill can hand off to Jev after the page has formatted or
    # moved its value. Never infer that it became public from current selectors.
    if any(e["type"] == "recovery.capture_suspended" for e in events):
        return
    if any(s.get("valueFromEnv") is not None for s in steps) and any(
        e["type"] == "action.start" and e["data"].get("engine") == "playwright"
        and e["data"].get("recoveryGuarded") is not True for e in events
    ):
        journal.append("recovery.capture_suspended", reason="Legacy dispatch cannot establish the environment-input boundary. Keep existing recovery inputs; do not collect new page values.")
        return
    # Capture also runs after a scoped/environment-backed step hands off to Jev.
    # Protect aliases in the top-level document without reading secret values.
    protected = [s["selector"] for s in steps
                 if s.get("valueFromEnv") is not None and s.get("selector") and not s.get("frames")]
    for field in fields:
        if field.get("frames") or field.get("shadow") == "open":
            continue  # Jev cannot type into these; the scoped adapter captures them.
        result = browser.evaluate("""(x=>{
          const nodes=[...document.querySelectorAll(x.selector)];
          if(nodes.length!==1)return null; const e=nodes[0];
          // Keep document scope: Element.matches() would rebind :scope to e.
          if(x.protected.some(selector=>[...document.querySelectorAll(selector)].includes(e)))return {forbidden:true};
          if(e.matches('input[type=password],input[type=file],[autocomplete=one-time-code]'))return {forbidden:true};
          if(!('value' in e))return {forbidden:true};
          return {value:String(e.value),matches:x.node!=null&&window.__jevFast?.nodes.get(x.node)===e};
        })(""" + json.dumps(dict(selector=field["selector"], protected=protected, node=action.get("node") if action else None)) + ")")
        if not result: continue
        if result.get("forbidden"): raise BridgeError("retention_forbidden", "A recovery field targets sensitive or unsupported input.")
        intended = action and action.get("kind") == "fill" and result.get("matches") and text is not None
        journal.save_field(field["key"], text if intended else result["value"], "intent" if intended else "observed")

def execute(request):
    verify_connection()
    from browser_harness.admin import ensure_daemon
    from browser_harness.helpers import cdp
    ensure_daemon()
    journal = Journal(request["root"], request["runId"])
    events = journal.events()
    target = next((e["data"] for e in reversed(events) if e["type"] == "target"), {})
    if target.get("targetId") != request["targetId"] or target.get("browserId") != os.environ["FASTEST_E2E_BROWSER_ID"]:
        raise BridgeError("target", "The adapter does not own this task tab.")
    require_target(request["targetId"], cdp)

    # -- OpenJEV support (additive; TypeSafe stays the default) -----------------
    # Provider selection rule:
    #   1. JEV_PROVIDER=openjev  -> OpenJEV
    #   2. TYPESAFE_API_KEY set  -> TypeSafe (unchanged default)
    #   3. Only OPENJEV_API_KEY  -> OpenJEV
    # jev_ultrafast hardcodes the TypeSafe endpoint and reads TYPESAFE_API_KEY /
    # TYPESAFE_MODEL from the environment.  When OpenJEV is selected we alias the
    # OpenJEV key into TYPESAFE_API_KEY (so jev_ultrafast finds it), set the model
    # id to "openjev", and redirect the request URL to the OpenJEV gateway via a
    # lightweight post_json patch.  Anyone with a TypeSafe key sees zero change.
    import jev_ultrafast.model as _jev_model
    _openjev_host = "https://api.openjev.sh/v1/systemone"
    _use_openjev = (
        os.environ.get("JEV_PROVIDER") == "openjev"
        or (not os.environ.get("TYPESAFE_API_KEY") and os.environ.get("OPENJEV_API_KEY"))
    )
    if _use_openjev:
        os.environ.setdefault("TYPESAFE_API_KEY", os.environ["OPENJEV_API_KEY"])
        os.environ.setdefault("TYPESAFE_MODEL", "openjev")
        _original_post_json = _jev_model.post_json

        def _openjev_post_json(url, key, body):
            return _original_post_json(_openjev_host, key, {**body, "model": "openjev"})

        _jev_model.post_json = _openjev_post_json
    # ------------------------------------------------------------------------

    import jev_ultrafast.agent as upstream
    from jev_ultrafast.browser import Browser, StalePage
    old_browser, old_choose, old_text = upstream.Browser, upstream.choose, upstream.field_text

    class AttachedBrowser(Browser):
        def __init__(self, _url):
            self.target = request["targetId"]
            self.session = cdp("Target.attachToTarget", targetId=self.target, flatten=True)["sessionId"]
        def close(self):
            # Agent initialization cleanup must not destroy the managed task tab.
            with contextlib.suppress(Exception): cdp("Target.detachFromTarget", sessionId=self.session)
        def act(self, action, page, text=None):
            if not self.fresh(page, action): raise StalePage("Observed target is stale before dispatch.")
            if action["kind"] not in {"click", "fill", "select", "scroll", "wait"}:
                raise BridgeError("unsupported", "Jev cannot execute this action kind.")
            capture(self, journal, action, text)
            journal.guard("action")
            ident = uuid.uuid4().hex
            journal.append("action.start", id=ident, kind=action["kind"], safeToRepeat=action["kind"] == "wait", targetHint=str(action.get("label", ""))[:120], engine="jev")
            try:
                result = super().act(action, page, text=text)
            except Exception as error:
                # Upstream tick retries StalePage. After dispatch begins, forbid that retry.
                raise BridgeError("mutation_uncertain", "Input dispatch was interrupted; inspect before recovery.") from error
            journal.append("action.end", id=ident)
            return result
        def observe(self, screenshot=False):
            value = super().observe(screenshot=screenshot)
            checkpoint(self, journal); capture(self, journal)
            return value

    def metered(fn, label):
        def wrapped(*args, **kwargs):
            journal.guard("call"); journal.append("call.start", engine=label)
            result = fn(*args, **kwargs)
            info = result[1] if isinstance(result, tuple) and len(result) == 2 else result
            if isinstance(info, dict) and isinstance(info.get("usage"), dict):
                journal.append("usage", engine=label, **{k: v for k, v in info["usage"].items() if isinstance(v, (int, float)) and "token" in k.lower()})
            return result
        return wrapped
    upstream.Browser = AttachedBrowser
    upstream.choose = metered(old_choose, "jev")
    upstream.field_text = metered(old_text, "text")
    agent = None
    try:
        agent = upstream.Agent(journal.meta["task"]["url"], request["goal"], screenshots=False)
        for _state in agent.run(): pass
        return dict(execution=agent.state["status"], reasonCode="complete" if agent.state["status"] == "done" else "engine_blocked")
    finally:
        if agent: agent.close()
        upstream.Browser, upstream.choose, upstream.field_text = old_browser, old_choose, old_text

def main():
    signal.signal(signal.SIGTERM, cancelled); signal.signal(signal.SIGINT, cancelled)
    try:
        raw = sys.stdin.read(1_000_001)
        if len(raw) > 1_000_000: raise BridgeError("input", "Request too large")
        with contextlib.redirect_stdout(sys.stderr): result = execute(json.loads(raw))
        envelope = dict(ok=True, result=result)
    except BridgeError as e: envelope = dict(ok=False, error=dict(code=e.code, reason=e.reason))
    except Cancelled: envelope = dict(ok=False, error=dict(code="cancelled", reason="Task cancelled; partial effects may exist."))
    except Exception: envelope = dict(ok=False, error=dict(code="engine", reason="Jev could not finish. Inspect the run; no action was retried."))
    print(json.dumps(envelope))

if __name__ == "__main__": main()

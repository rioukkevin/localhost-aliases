import Foundation

// =============================================================================================
//  Harness for ApplyRequestWatcher.
//
//  It compiles the REAL Sources/ApplyRequestWatcher.swift (plus Paths.swift and Logger.swift) —
//  no logic is copied here. PrivilegedApply.swift, the only file that can raise a password
//  dialog, is deliberately NOT part of this target: the watcher takes its runner as a closure,
//  and the stub below is all this binary can ever run.
//
//  Everything it touches lives under a fresh temp directory. It never reads or writes
//  ~/.config/localhost-aliases, /etc/hosts or anything else on the machine.
//
//  (Top-level code has to live in a file called main.swift, hence the name.)
//
//    make -C apps/tray test
// =============================================================================================

var failures = 0
var checks = 0

func check(_ condition: Bool, _ name: String) {
    checks += 1
    if condition {
        print("  ok   \(name)")
    } else {
        failures += 1
        print("  FAIL \(name)")
    }
}

func request(_ id: String, _ kind: PrivilegedRequestKind, ageSeconds: TimeInterval, now: Date)
    -> PrivilegedRequestRecord
{
    PrivilegedRequestRecord(id: id, kind: kind, requestedAt: now.addingTimeInterval(-ageSeconds))
}

let now = Date()
let temp = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("la-watcher-tests-\(UUID().uuidString)")
try! FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)

let requestPath = temp.appendingPathComponent("apply-request.json").path
let resultPath = temp.appendingPathComponent("apply-result.json").path
let log = Logger(path: temp.appendingPathComponent("tray.log").path)

func writeRequest(id: String, kind: String, requestedAt: Date) {
    let stamp = ISO8601DateFormatter()
    stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let json = """
        {"id":"\(id)","kind":"\(kind)","requestedAt":"\(stamp.string(from: requestedAt))"}
        """
    try! json.write(toFile: requestPath, atomically: true, encoding: .utf8)
}

// -- 1. the pure decision --------------------------------------------------------------------

print("decide()")
let fresh = request("a", .apply, ageSeconds: 2, now: now)

check(
    ApplyRequestWatcher.decide(request: fresh, lastHandledId: nil, isBusy: false, now: now)
        == .handle, "a fresh request is handled")
check(
    ApplyRequestWatcher.shouldHandle(request: fresh, lastHandledId: nil, now: now),
    "shouldHandle agrees for a fresh request")
check(
    ApplyRequestWatcher.decide(request: fresh, lastHandledId: "a", isBusy: false, now: now)
        == .ignoreAlreadyHandled, "the same id is never handled twice")
check(
    !ApplyRequestWatcher.shouldHandle(request: fresh, lastHandledId: "a", now: now),
    "shouldHandle agrees for a duplicate id")
check(
    ApplyRequestWatcher.decide(
        request: request("b", .apply, ageSeconds: Paths.applyRequestTtl + 1, now: now),
        lastHandledId: nil, isBusy: false, now: now) == .ignoreStale,
    "a request older than the TTL is ignored (no prompt on launch)")
check(
    ApplyRequestWatcher.decide(
        request: request("b", .apply, ageSeconds: Paths.applyRequestTtl - 1, now: now),
        lastHandledId: nil, isBusy: false, now: now) == .handle,
    "a request just inside the TTL is still handled")
check(
    ApplyRequestWatcher.decide(
        request: request("c", .apply, ageSeconds: -(Paths.applyRequestTtl + 1), now: now),
        lastHandledId: nil, isBusy: false, now: now) == .ignoreStale,
    "a request stamped far in the future is ignored too")
check(
    ApplyRequestWatcher.decide(request: fresh, lastHandledId: nil, isBusy: true, now: now)
        == .ignoreBusy, "nothing starts while another privileged run is in flight")
check(
    ApplyRequestWatcher.decide(request: nil, lastHandledId: nil, isBusy: false, now: now)
        == .ignoreUnreadable, "no request means no action")

// -- 2. decoding -----------------------------------------------------------------------------

print("decodeRequest()")
let good = Data(
    #"{"id":"x","kind":"uninstall","requestedAt":"2026-08-13T10:00:00.000Z"}"#.utf8)
check(ApplyRequestWatcher.decodeRequest(good)?.id == "x", "a well-formed request decodes")
check(ApplyRequestWatcher.decodeRequest(good)?.kind == .uninstall, "kind decodes")
check(
    ApplyRequestWatcher.decodeRequest(
        Data(#"{"id":"x","kind":"apply","requestedAt":"2026-08-13T10:00:00Z"}"#.utf8)) != nil,
    "a stamp without milliseconds decodes")
for (label, raw) in [
    ("truncated json", #"{"id":"x","kind":"apply""#),
    ("not json at all", "not json"),
    ("empty file", ""),
    ("missing id", #"{"kind":"apply","requestedAt":"2026-08-13T10:00:00.000Z"}"#),
    ("empty id", #"{"id":"","kind":"apply","requestedAt":"2026-08-13T10:00:00.000Z"}"#),
    ("unknown kind", #"{"id":"x","kind":"rm -rf","requestedAt":"2026-08-13T10:00:00.000Z"}"#),
    ("bad timestamp", #"{"id":"x","kind":"apply","requestedAt":"yesterday"}"#),
    ("id is not a string", #"{"id":7,"kind":"apply","requestedAt":"2026-08-13T10:00:00.000Z"}"#),
] {
    check(
        ApplyRequestWatcher.decodeRequest(Data(raw.utf8)) == nil,
        "malformed request rejected: \(label)")
}

// -- 3. result encoding ----------------------------------------------------------------------

print("encodeResult()")
let started = now
let finished = now.addingTimeInterval(4)
let okData = ApplyRequestWatcher.encodeResult(
    id: "r1", kind: .apply, ok: true, cancelled: false, error: nil, startedAt: started,
    finishedAt: finished)
let okJSON = try! JSONSerialization.jsonObject(with: okData) as! [String: Any]
check(okJSON["id"] as? String == "r1", "result carries the request id")
check(okJSON["kind"] as? String == "apply", "result carries the kind")
check(okJSON["ok"] as? Bool == true, "ok is a real boolean")
check(okJSON["cancelled"] as? Bool == false, "cancelled is a real boolean")
check(okJSON["error"] is NSNull, "error is an explicit null on success")
check(okJSON["startedAt"] is String && okJSON["finishedAt"] is String, "both stamps are present")
// The stamps go out as `2026-08-13T10:00:00.123Z` — what `new Date().toISOString()` produces
// and what `new Date(...)` on the dashboard side reads back.
check(
    (okJSON["startedAt"] as! String).hasSuffix("Z")
        && ApplyRequestWatcher.parseTimestamp(okJSON["startedAt"] as! String) != nil,
    "startedAt is ISO-8601 with milliseconds, and round-trips")
check(
    abs(
        ApplyRequestWatcher.parseTimestamp(okJSON["finishedAt"] as! String)!
            .timeIntervalSince(finished)) < 0.01, "finishedAt round-trips to the same instant")

let cancelledData = ApplyRequestWatcher.encodeResult(
    id: "r2", kind: .uninstall, ok: false, cancelled: true,
    error: ApplyRequestWatcher.errorMessage(from: "", cancelled: true), startedAt: started,
    finishedAt: finished)
let cancelledJSON = try! JSONSerialization.jsonObject(with: cancelledData) as! [String: Any]
check(
    cancelledJSON["ok"] as? Bool == false && cancelledJSON["cancelled"] as? Bool == true,
    "a cancelled prompt is ok=false, cancelled=true")
check((cancelledJSON["error"] as? String)?.isEmpty == false, "a cancellation still explains itself")
check(
    ApplyRequestWatcher.errorMessage(from: "  boom  ", cancelled: false) == "boom",
    "a real error keeps the script's message")
check(
    ApplyRequestWatcher.errorMessage(from: String(repeating: "x", count: 5000), cancelled: false)
        .count == 2000, "a runaway script log is truncated")

// -- 4. atomic write -------------------------------------------------------------------------

print("writeResult()")
check(ApplyRequestWatcher.writeResult(okData, to: resultPath), "the result is written")
check(
    (try? Data(contentsOf: URL(fileURLWithPath: resultPath))) == okData,
    "the file holds exactly what was encoded")
check(ApplyRequestWatcher.writeResult(cancelledData, to: resultPath), "a result replaces the previous one")
check(
    ((try? JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: resultPath)))) as? [String: Any])?["id"]
        as? String == "r2", "the replacement is complete and parseable")
check(
    (try! FileManager.default.contentsOfDirectory(atPath: temp.path)).allSatisfy {
        !$0.hasSuffix(".tmp")
    }, "no temp file is left behind")

// -- 5. the watcher end to end, with a stubbed privileged runner -------------------------------

print("pollOnce() with a stub runner")
var runs: [PrivilegedRequestKind] = []
var pending: ((PrivilegedRunOutcome) -> Void)?
var hostBusy = false

let watcher = ApplyRequestWatcher(
    log: log,
    requestPath: requestPath,
    resultPath: resultPath,
    isBusy: { hostBusy },
    run: { kind, completion in
        runs.append(kind)
        hostBusy = true
        pending = completion  // held open: the password dialog is "on screen"
    })

try? FileManager.default.removeItem(atPath: resultPath)

watcher.pollOnce()
check(runs.isEmpty, "no request file, no run")

writeRequest(id: "req-1", kind: "apply", requestedAt: Date())
watcher.pollOnce()
check(runs == [.apply], "a fresh request runs the privileged work exactly once")

watcher.pollOnce()
watcher.pollOnce()
check(runs == [.apply], "polling while the prompt is up never starts a second run")

pending?(PrivilegedRunOutcome(ok: true, cancelled: false, output: ""))
hostBusy = false
pending = nil
let firstResult =
    (try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: resultPath))))
    as! [String: Any]
check(firstResult["id"] as? String == "req-1", "the result carries the same id as the request")
check(firstResult["ok"] as? Bool == true, "the result reports success")
check(
    !FileManager.default.fileExists(atPath: requestPath),
    "the handled request file is removed so it cannot be reprocessed")

writeRequest(id: "req-1", kind: "apply", requestedAt: Date())
watcher.pollOnce()
check(runs == [.apply], "a re-appearing id is never handled twice")

writeRequest(id: "req-stale", kind: "apply", requestedAt: Date(timeIntervalSinceNow: -600))
watcher.pollOnce()
check(runs == [.apply], "a stale request on disk raises no prompt")
check(!FileManager.default.fileExists(atPath: requestPath), "the stale request is dropped")

try! "{ this is not json".write(toFile: requestPath, atomically: true, encoding: .utf8)
watcher.pollOnce()
check(runs == [.apply], "a malformed request raises no prompt")

writeRequest(id: "req-2", kind: "uninstall", requestedAt: Date())
watcher.pollOnce()
check(runs == [.apply, .uninstall], "the next id is handled, and kind is honoured")
pending?(PrivilegedRunOutcome(ok: false, cancelled: true, output: "User canceled. (-128)"))
hostBusy = false
let secondResult =
    (try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: resultPath))))
    as! [String: Any]
check(secondResult["id"] as? String == "req-2", "a cancelled run still writes a result")
check(
    secondResult["ok"] as? Bool == false && secondResult["cancelled"] as? Bool == true,
    "the cancellation is reported as cancelled, not as a failure")

hostBusy = true
writeRequest(id: "req-3", kind: "apply", requestedAt: Date())
watcher.pollOnce()
check(runs.count == 2, "a menu-driven prompt blocks the channel instead of stacking a second one")
hostBusy = false
watcher.pollOnce()
check(runs.count == 3, "and the request is picked up once the menu run finishes")

// -- 6. a relaunch must not replay a request that was already answered ------------------------
//
// `lastHandledId` lives in memory. If the app is quit (or crashes) between writing the result
// and deleting the request, a fresh watcher would see a request that is still inside the TTL.
// Replaying it means a password dialog for a click the user already answered, so the result
// file on disk has to stand in for the memory that was lost.

print("a relaunched watcher")
pending?(PrivilegedRunOutcome(ok: true, cancelled: false, output: ""))
hostBusy = false
pending = nil

var relaunchRuns: [PrivilegedRequestKind] = []
func relaunched() -> ApplyRequestWatcher {
    ApplyRequestWatcher(
        log: log,
        requestPath: requestPath,
        resultPath: resultPath,
        isBusy: { false },
        run: { kind, completion in
            relaunchRuns.append(kind)
            completion(PrivilegedRunOutcome(ok: true, cancelled: false, output: ""))
        })
}

// The crash: result for req-3 is on disk, but its request was never deleted.
writeRequest(id: "req-3", kind: "apply", requestedAt: Date())
relaunched().pollOnce()
check(relaunchRuns.isEmpty, "a request already answered on disk is not replayed after a restart")
check(
    !FileManager.default.fileExists(atPath: requestPath),
    "and the leftover request file is dropped, so it cannot later look unanswered")

// A genuinely new click after that restart still works.
writeRequest(id: "req-4", kind: "apply", requestedAt: Date())
relaunched().pollOnce()
check(relaunchRuns == [.apply], "a new id after a restart is still handled")
let fourth =
    (try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: resultPath))))
    as! [String: Any]
check(fourth["id"] as? String == "req-4", "and its result replaces the previous one")

print("")
print("\(checks - failures)/\(checks) checks passed")
try? FileManager.default.removeItem(at: temp)
exit(failures == 0 ? 0 : 1)

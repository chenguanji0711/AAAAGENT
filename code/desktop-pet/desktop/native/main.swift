import Foundation
import Darwin
import AVFoundation

// All state and callbacks run on the main queue. Pipe I/O is nonblocking so a
// backend that stops reading cannot freeze the window or prevent cancellation.
final class BackendConnection {
    private(set) var generation = 0
    private(set) var state = "disconnected"
    var onState: ((Int, String, String) -> Void)?
    var onMessage: ((Int, [String: Any]) -> Void)?
    private var process: Process?
    var processIdentifier: Int32? { process?.processIdentifier }
    private var reader: DispatchSourceRead?
    private var writer: DispatchSourceWrite?
    private var writerSuspended = true
    private var output: Int32 = -1
    private var incoming = Data(), outgoing = Data()
    private var deadline: DispatchWorkItem?
    private let limit = 64 * 1024 * 1024
    var startupTimeout: Double = 15

    func start(executable: String?, arguments: [String] = []) {
        close()
        generation += 1
        let epoch = generation
        state = "connecting"; onState?(epoch, state, "")
        if let executable {
            let child = Process(), into = Pipe(), from = Pipe()
            child.executableURL = URL(fileURLWithPath: executable); child.arguments = arguments
            child.standardInput = into; child.standardOutput = from; child.standardError = FileHandle.standardError
            child.terminationHandler = { [weak self] child in
                DispatchQueue.main.async { self?.fail(epoch, "disconnected", "exit:\(child.terminationStatus)") }
            }
            do {
                try child.run(); process = child
                let input = dup(from.fileHandleForReading.fileDescriptor)
                let output = dup(into.fileHandleForWriting.fileDescriptor)
                // The parent must not retain the child's pipe ends (EOF/EPIPE).
                try? into.fileHandleForReading.close(); try? into.fileHandleForWriting.close()
                try? from.fileHandleForReading.close(); try? from.fileHandleForWriting.close()
                attach(input: input, output: output, epoch: epoch)
            } catch { fail(epoch, "failed", "launch"); return }
        } else {
            // Existing explicit stdio harness; reconnect requires a launch command.
            attach(input: dup(STDIN_FILENO), output: dup(STDOUT_FILENO), epoch: epoch)
        }
        guard state == "connecting" else { return }
        let timeout = DispatchWorkItem { [weak self] in self?.fail(epoch, "failed", "ready-timeout") }
        deadline = timeout; DispatchQueue.main.asyncAfter(deadline: .now() + startupTimeout, execute: timeout)
    }
    private func attach(input: Int32, output: Int32, epoch: Int) {
        guard input >= 0, output >= 0 else {
            if input >= 0 { Darwin.close(input) }; if output >= 0 { Darwin.close(output) }
            fail(epoch, "failed", "pipe"); return
        }
        _ = fcntl(input, F_SETFL, fcntl(input, F_GETFL) | O_NONBLOCK)
        _ = fcntl(output, F_SETFL, fcntl(output, F_GETFL) | O_NONBLOCK)
        // Broken pipes become a recoverable write error, never SIGPIPE termination.
        _ = fcntl(output, F_SETNOSIGPIPE, 1)
        self.output = output
        let readSource = DispatchSource.makeReadSource(fileDescriptor: input, queue: .main)
        readSource.setEventHandler { [weak self] in self?.read(input, epoch: epoch) }
        readSource.setCancelHandler { Darwin.close(input) }; reader = readSource; readSource.resume()
        let writeSource = DispatchSource.makeWriteSource(fileDescriptor: output, queue: .main)
        writeSource.setEventHandler { [weak self] in self?.flush(epoch) }
        writeSource.setCancelHandler { Darwin.close(output) }; writer = writeSource; writerSuspended = true
    }
    private func read(_ fd: Int32, epoch: Int) {
        guard live(epoch) else { return }
        var bytes = [UInt8](repeating: 0, count: 65536)
        for _ in 0..<16 {
            let count = Darwin.read(fd, &bytes, bytes.count)
            if count == 0 { fail(epoch, "disconnected", "eof"); return }
            if count < 0 {
                if errno == EINTR { continue }; if errno == EAGAIN { return }
                fail(epoch, "disconnected", "read"); return
            }
            incoming.append(contentsOf: bytes.prefix(count))
            guard incoming.count <= limit else { fail(epoch, "failed", "message-too-large"); return }
            while let newline = incoming.firstIndex(of: 10) {
                let line = Data(incoming[incoming.startIndex..<newline]); incoming.removeSubrange(incoming.startIndex...newline)
                guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                    fail(epoch, "failed", "invalid-message"); return
                }
                if message["channel"] as? String == "backend_ready" {
                    guard state == "connecting" else { continue }
                    state = "ready"; deadline?.cancel(); deadline = nil
                } else if state != "ready" { continue }
                onMessage?(epoch, message)
                guard live(epoch) else { return }
            }
        }
    }
    @discardableResult func send(_ message: [String: Any], generation epoch: Int) -> Bool {
        guard epoch == generation, state == "ready", output >= 0,
              let data = try? JSONSerialization.data(withJSONObject: message) else { return false }
        guard outgoing.count + data.count + 1 <= limit else { fail(epoch, "failed", "write-overflow"); return false }
        outgoing.append(data); outgoing.append(10)
        flush(epoch)
        if !outgoing.isEmpty && writerSuspended { writerSuspended = false; writer?.resume() }
        return state == "ready"
    }
    private func flush(_ epoch: Int) {
        guard live(epoch), output >= 0 else { return }
        // Bound work per callback; backpressure is resumed by the writable source.
        for _ in 0..<16 {
            if outgoing.isEmpty { break }
            let count = outgoing.withUnsafeBytes { Darwin.write(output, $0.baseAddress!, min($0.count, 65536)) }
            if count < 0 {
                if errno == EINTR { continue }; if errno == EAGAIN { break }
                fail(epoch, "disconnected", "write"); return
            }
            if count == 0 { break }
            outgoing.removeFirst(count)
        }
        if outgoing.isEmpty && !writerSuspended { writer?.suspend(); writerSuspended = true }
    }
    private func live(_ epoch: Int) -> Bool { epoch == generation && (state == "connecting" || state == "ready") }
    private func fail(_ epoch: Int, _ state: String, _ reason: String) {
        guard live(epoch) else { return }
        close(); self.state = state; onState?(epoch, state, reason)
    }
    func close() {
        state = "disconnected"; deadline?.cancel(); deadline = nil
        reader?.cancel(); reader = nil
        if writerSuspended { writer?.resume() }; writer?.cancel(); writer = nil; writerSuspended = true
        output = -1; incoming.removeAll(); outgoing.removeAll()
        if let child = process {
            child.terminationHandler = nil
            if child.isRunning {
                child.terminate()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { if child.isRunning { kill(child.processIdentifier, SIGKILL) } }
            }
        }
        process = nil
    }
}

// The renderer supplies only an intent. The existing local helper validates the
// current session/PID/instance and loopback URL before opening the browser.
final class ManagementPageLauncher {
    private var process: Process?
    private var deadline: DispatchWorkItem?
    private var completion: ((Bool) -> Void)?
    private let timeout: TimeInterval
    init(timeout: TimeInterval = 5) { self.timeout = timeout }
    @discardableResult
    func open(desktopRoot: URL, node: String, workbench: [String:Any]? = nil, completion: @escaping (Bool) -> Void) -> Bool {
        guard process == nil else { return false }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: node)
        child.arguments = [desktopRoot.deletingLastPathComponent().appendingPathComponent(workbench == nil ? "tools/start-management.mjs" : "tools/start-workbench.mjs").path]
        if let workbench, let encoded = try? JSONSerialization.data(withJSONObject:workbench), let text = String(data:encoded,encoding:.utf8) {
            child.arguments?.append(text)
        }
        child.currentDirectoryURL = desktopRoot.deletingLastPathComponent()
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        self.completion = completion; process = child
        child.terminationHandler = { [weak self] task in
            DispatchQueue.main.async { self?.finish(task, ok:task.terminationStatus == 0) }
        }
        do { try child.run() } catch { finish(child,ok:false); return true }
        let limit = DispatchWorkItem { [weak self, weak child] in
            guard let self, let child, self.process === child else { return }
            // This read-only helper has no data to flush. End it immediately so
            // a timeout cannot leave a late browser-opening attempt behind.
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }; self.finish(child,ok:false)
        }
        deadline = limit; DispatchQueue.main.asyncAfter(deadline:.now()+timeout,execute:limit)
        return true
    }
    private func finish(_ child:Process,ok:Bool) {
        guard process === child else { return }
        deadline?.cancel(); deadline = nil; child.terminationHandler = nil; process = nil
        let done = completion; completion = nil; done?(ok)
    }
    func cancel() {
        guard let child = process else { return }
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }; finish(child,ok:false)
    }
}

#if !DESKTOP_CONNECTION_TEST
import AppKit
import WebKit
import UniformTypeIdentifiers
import QuartzCore

final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
final class AssetScheme: NSObject, WKURLSchemeHandler {
    let root: URL
    private final class Transfer {
        let task: WKURLSchemeTask
        // File state is only touched on the serial I/O queue.
        var handle: FileHandle?
        var remaining: UInt64 = 0
        init(_ task: WKURLSchemeTask) { self.task = task }
        func close() { try? handle?.close(); handle = nil }
    }
    private let io = DispatchQueue(label:"aaaagent.pet-assets", qos:.userInitiated)
    // Membership and all WK callbacks are confined to the main queue.
    private var transfers: [ObjectIdentifier: Transfer] = [:]
    init(root: URL) { self.root = root.resolvingSymlinksInPath() }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task as AnyObject), transfer = Transfer(task)
        let request = task.request
        transfers[id] = transfer
        io.async {
            do {
                guard let url = request.url, ["GET", "HEAD"].contains(request.httpMethod ?? "GET")
                else { throw URLError(.unsupportedURL) }
                let plan = try PetAssetResponse.prepare(root:self.root, url:url, range:request.value(forHTTPHeaderField:"Range"))
                guard let response = HTTPURLResponse(url:url, statusCode:plan.status, httpVersion:"HTTP/1.1", headerFields:plan.headers)
                else { throw URLError(.badServerResponse) }
                transfer.remaining = request.httpMethod == "HEAD" ? 0 : plan.length
                if transfer.remaining > 0 {
                    transfer.handle = try FileHandle(forReadingFrom:plan.file)
                    try transfer.handle?.seek(toOffset:plan.offset)
                }
                DispatchQueue.main.async {
                    guard self.transfers[id] === transfer else { return }
                    task.didReceive(response)
                    self.readNext(id, transfer)
                }
            } catch {
                transfer.close()
                DispatchQueue.main.async { self.fail(id, transfer, error) }
            }
        }
    }
    private func readNext(_ id: ObjectIdentifier, _ transfer: Transfer) {
        guard transfers[id] === transfer else { return }
        io.async {
            do {
                let count = Int(min(transfer.remaining, 64 * 1024))
                let data: Data
                if count == 0 { data = Data() }
                else {
                    guard let handle = transfer.handle else { throw URLError(.cannotOpenFile) }
                    data = try handle.read(upToCount:count) ?? Data()
                }
                guard count == 0 || !data.isEmpty else { throw URLError(.cannotDecodeRawData) }
                transfer.remaining -= UInt64(data.count)
                let finished = transfer.remaining == 0
                if finished { transfer.close() }
                DispatchQueue.main.async {
                    guard self.transfers[id] === transfer else { return }
                    if !data.isEmpty { transfer.task.didReceive(data) }
                    guard self.transfers[id] === transfer else { return }
                    if finished {
                        self.transfers.removeValue(forKey:id)
                        transfer.task.didFinish()
                    } else { self.readNext(id, transfer) }
                }
            } catch {
                transfer.close()
                DispatchQueue.main.async { self.fail(id, transfer, error) }
            }
        }
    }
    private func fail(_ id: ObjectIdentifier, _ transfer: Transfer, _ error: Error) {
        guard transfers[id] === transfer else { return }
        transfers.removeValue(forKey:id)
        transfer.task.didFailWithError(error)
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        if let transfer = transfers.removeValue(forKey:ObjectIdentifier(task as AnyObject)) {
            io.async { transfer.close() }
        }
    }
}
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    var panel: PetPanel!
    var web: WKWebView!
    var viewportClip: NSView!
    var modelScreenFrame: CGRect?
    // Preserve user intent separately from screen-fitting results.
    var desiredModelTop: CGPoint?
    var desiredBallTop: CGPoint?
    var collapsedScreenFrame: CGRect?
    let connection = BackendConnection()
    let managementLauncher = ManagementPageLauncher()
    let displayPreferences = PetDisplayPreferences()
    var speechVisible = true
    var speechHeight = 84.0
    var quickHeight = 56.0
    var displayOpen = false
    var displayCollapsed = false
    var applyingDisplay = false
    var pageReady = false
    var rendererKind = UserDefaults.standard.string(forKey:"petDisplay.rendererKind") == "live2d" ? "live2d" : "video"
    var sourceRoot: URL!
    var voiceRequested = false
    var wakeRequested = false
    var captureTimer: Timer?
    var lastCaptureState = ""
    let args = CommandLine.arguments
    func option(_ name: String) -> String? {
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }; return args[i + 1]
    }
    func diagnostic(_ name: String, _ values: [String: Any] = [:]) {
        var record = values; record["name"] = name; record["at"] = ISO8601DateFormatter().string(from: Date())
        if let d = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) {
            FileHandle.standardError.write(d); FileHandle.standardError.write(Data([10]))
        }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        diagnostic("device-authorization", ["microphone": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
            "camera": AVCaptureDevice.authorizationStatus(for: .video).rawValue])
        guard let root = option("--root") else { diagnostic("missing-root"); NSApp.terminate(nil); return }
        sourceRoot = URL(fileURLWithPath: root, isDirectory: true).standardizedFileURL
        if let kind = option("--renderer"), ["video", "live2d"].contains(kind) { rendererKind = kind }
        NSApp.setActivationPolicy(.accessory)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(AssetScheme(root: sourceRoot), forURLScheme: "pet")
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "desktop")
        config.userContentController.add(self, name: "shell")
        config.userContentController.add(self, name: "diagnostic")
        web = WKWebView(frame: .zero, configuration: config)
        // The transparent host is not a control. DOM buttons/input keep their
        // own keyboard focus indicators without outlining the entire pet window.
        web.focusRingType = .none
        web.navigationDelegate = self; web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = .clear
        web.isInspectable = args.contains("--inspect")
        captureTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            let camera = self.web.cameraCaptureState.rawValue, microphone = self.web.microphoneCaptureState.rawValue
            let state = "\(camera):\(microphone)"
            if state != self.lastCaptureState {
                self.lastCaptureState = state
                self.diagnostic("device-state", ["camera": camera, "microphone": microphone])
            }
        }
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        panel = PetPanel(contentRect: NSRect(x: visible.maxX - 410, y: visible.minY + 250, width: 380, height: 360), styleMask: [.borderless], backing: .buffered, defer: false)
        panel.delegate = self
        panel.title = "AAAAGENT"; panel.isOpaque = false; panel.backgroundColor = .clear
        panel.hasShadow = false; panel.level = .floating; panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        viewportClip = NSView(frame:.zero)
        viewportClip.wantsLayer = true; viewportClip.layer?.masksToBounds = true
        web.autoresizingMask = []
        viewportClip.addSubview(web)
        panel.isMovableByWindowBackground = false; panel.contentView = viewportClip
        panel.becomesKeyOnlyIfNeeded = false
        applyDisplay()
        panel.orderFrontRegardless()
        setupMenu()
        if args.contains("--inspect") {
            NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
                self?.diagnostic("key-routing", ["isKey": self?.panel.isKeyWindow ?? false, "isActive": NSApp.isActive, "responder": String(describing: self?.panel.firstResponder)])
                return event
            }
        }
        connection.onState = { [weak self] epoch, state, reason in
            guard let self else { return }
            self.voiceRequested = false; self.wakeRequested = false
            self.diagnostic("backend-connection", ["generation": epoch, "state": state, "reason": reason])
            self.deliver("connectionChanged", ["generation": epoch, "state": state, "reason": reason, "canRetry": self.option("--backend") != nil])
        }
        connection.onMessage = { [weak self] epoch, message in self?.receive(message, generation: epoch) }
        let url = option("--url").flatMap(URL.init(string:)) ?? URL(string: "pet://app/index.html")!
        web.load(URLRequest(url: url))
        diagnostic("window-created", ["opaque": panel.isOpaque, "width": 380, "height": 360, "origin": url.scheme ?? "unknown"])
    }
    func setupMenu() {
        let menu = NSMenu(); let item = NSMenuItem(); menu.addItem(item)
        let sub = NSMenu(); sub.addItem(withTitle: "退出AAAAGENT", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = sub
        let edit = NSMenuItem(); let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = editMenu; menu.addItem(edit); NSApp.mainMenu = menu
    }
    func startTransport() {
        let path = option("--backend")
        connection.start(executable: path == nil ? nil : option("--node") ?? "/opt/homebrew/bin/node", arguments: path.map { [$0] } ?? [])
    }
    /// The settings the page and the renderer share: five normalised knobs plus the chosen behaviour.
    func deliverMotionConfig() {
        var payload = MotionPreferences.load().dictionary
        payload["animation"] = MotionPreferences.loadAnimation()
        deliver("motionConfig", payload)
    }
    func deliver(_ method: String, _ object: [String: Any], suffix: String = "") {
        guard pageReady, let data = try? JSONSerialization.data(withJSONObject: object), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("void window.petBridge?.\(method)(\(json)\(suffix))") { _, error in
            if let error { self.diagnostic("bridge-delivery-failed", ["message": error.localizedDescription]) }
        }
    }
    /// The durable copy of the pet's output level; the page applies it to every sound it makes.
    func deliverAudioConfig() {
        let stored = UserDefaults.standard.object(forKey: "petAudio.volume") as? Double
        deliver("audioConfig", ["muted": UserDefaults.standard.bool(forKey: "petAudio.muted"),
            "volume": stored.map { min(1, max(0, $0)) } ?? 1])
    }
    func receive(_ object: [String: Any], generation: Int) {
        guard generation == connection.generation else { return }
        if object["channel"] as? String == "wake_control" { wakeRequested = object["enabled"] as? Bool == true }
        if object["channel"] as? String == "wake_error" { wakeRequested = false }
        deliver("receive", object, suffix: ", \(generation)")
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        if message.name == "diagnostic" {
            if let value = message.body as? [String: Any] { diagnostic("renderer", value) }; return
        }
        guard let value = message.body as? [String: Any] else { return }
        if message.name == "shell" {
            switch value["type"] as? String {
            case "ready":
                pageReady = true; applyDisplay(); startTransport()
                deliver("hotkeyConfig", ["code": UserDefaults.standard.string(forKey: "voiceHotkeyCode") as Any? ?? NSNull()])
                deliverAudioConfig()
                deliverMotionConfig()
            case "set_audio":
                // The pet's own output level. Kept beside the other shell preferences.
                if let muted = value["muted"] as? Bool { UserDefaults.standard.set(muted, forKey: "petAudio.muted") }
                if let volume = value["volume"] as? Double, volume.isFinite {
                    UserDefaults.standard.set(min(1, max(0, volume)), forKey: "petAudio.volume")
                }
                deliverAudioConfig()
            case "set_motion":
                // The durable copy of the motion knobs. Normalisation happens in the helper, so a
                // corrupt or hand-edited value can never reach the page or the renderer.
                if let patch = value["settings"] as? [String: Any] {
                    MotionPreferences.save(MotionSettings.normalize(patch))
                }
                if let animation = value["animation"] as? String {
                    MotionPreferences.saveAnimation(animation)
                }
                deliverMotionConfig()
            case "set_chat_hud":
                guard let visible = value["visible"] as? Bool else { return }
                let height = value["height"] as? Double ?? speechHeight
                let quick = value["quickHeight"] as? Double ?? quickHeight
                guard height.isFinite, quick.isFinite else { return }
                let bounded = min(160, max(1, height)), boundedQuick = min(112, max(40, quick))
                if visible != speechVisible || abs(bounded-speechHeight) > 0.5 || abs(boundedQuick-quickHeight) > 0.5 {
                    speechVisible = visible; speechHeight = bounded; quickHeight = boundedQuick; applyDisplay()
                }
            case "set_display":
                if let mode = value["mode"] as? String { displayPreferences.setMode(mode); applyDisplay() }
            case "set_renderer":
                if let kind = value["rendererKind"] as? String, ["video", "live2d"].contains(kind) {
                    rendererKind = kind
                    UserDefaults.standard.set(kind, forKey:"petDisplay.rendererKind")
                    applyDisplay()
                }
            case "resize_model":
                if let phase = value["phase"] as? String { displayPreferences.resize(phase, width: value["width"] as? Double); applyDisplay() }
            case "set_collapsed":
                if let collapsed = value["collapsed"] as? Bool, collapsed != displayCollapsed {
                    displayPreferences.resize("cancel",width:nil)
                    if let open = value["open"] as? Bool { displayOpen = open }
                    displayCollapsed = collapsed
                    applyDisplay()
                    diagnostic("pet-collapsed",["collapsed":collapsed,"width":panel.frame.width,"height":panel.frame.height])
                }
            case "set_hotkey":
                if let code = value["code"] as? String {
                    let pattern = "^(Arrow(Up|Down|Left|Right)|Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|20)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$"
                    guard code.range(of: pattern, options: .regularExpression) != nil else { return }
                    UserDefaults.standard.set(code, forKey: "voiceHotkeyCode")
                } else { UserDefaults.standard.removeObject(forKey: "voiceHotkeyCode") }
                deliver("hotkeyConfig", ["code": UserDefaults.standard.string(forKey: "voiceHotkeyCode") as Any? ?? NSNull()])
            case "reconnect":
                if option("--backend") != nil && ["failed", "disconnected"].contains(connection.state) { startTransport() }
            case "open_workbench":
                var target = value
                target.removeValue(forKey:"type")
                let opening = managementLauncher.open(desktopRoot:sourceRoot,node:option("--node") ?? "/opt/homebrew/bin/node",workbench:target) { [weak self] ok in
                    self?.deliver("workbenchOpenResult",["ok":ok])
                }
                if !opening { deliver("workbenchOpenResult",["ok":false]) }
            case "open_management":
                managementLauncher.open(desktopRoot:sourceRoot,node:option("--node") ?? "/opt/homebrew/bin/node") { [weak self] ok in
                    self?.deliver("managementResult",["ok":ok])
                }
            case "disconnect":
                if value["generation"] as? Int == connection.generation { connection.close(); voiceRequested = false; wakeRequested = false }
            case "panel":
                let open = value["open"] as? Bool ?? false
                displayOpen = open; displayPreferences.resize("cancel", width: nil); applyDisplay()
                if open && !displayCollapsed { NSApp.activate(ignoringOtherApps: true); panel.makeKeyAndOrderFront(nil); panel.makeFirstResponder(web) }
                diagnostic("panel", ["open": open, "isKey": panel.isKeyWindow])
            case "focus": NSApp.activate(ignoringOtherApps: true); panel.makeKeyAndOrderFront(nil); panel.makeFirstResponder(web)
            case "drag":
                if let dx = value["dx"] as? Double, let dy = value["dy"] as? Double, dx.isFinite, dy.isFinite {
                    let model = displayCollapsed ? (collapsedScreenFrame ?? panel.frame) : (modelScreenFrame ?? panel.frame)
                    applyDisplay(proposedModelTop:CGPoint(x:model.midX+dx,y:model.maxY-dy))
                }
            case "quit": NSApp.terminate(nil)
            default: break
            }; return
        }
        guard let epoch = value["generation"] as? Int, epoch == connection.generation, connection.state == "ready",
              let payload = value["message"] as? [String: Any] else { return }
        if let command = payload["command"] as? [String: Any], let type = command["type"] as? String {
            if type == "start_voice" || type == "click_invitation" {
                voiceRequested = true
                let forward = { [weak self] in
                    guard let self, self.voiceRequested, self.connection.generation == epoch else { return }
                    if !self.connection.send(payload, generation: epoch) { self.voiceRequested = false }
                }
                let camera = { [weak self] in
                    guard let self, self.voiceRequested, self.connection.generation == epoch else { return }
                    let status = AVCaptureDevice.authorizationStatus(for: .video)
                    if status == .notDetermined {
                        AVCaptureDevice.requestAccess(for: .video) { granted in
                            DispatchQueue.main.async {
                                self.diagnostic("camera-authorization-result", ["granted": granted])
                                forward()
                            }
                        }
                    } else { forward() }
                }
                let status = AVCaptureDevice.authorizationStatus(for: .audio)
                if status == .notDetermined {
                    AVCaptureDevice.requestAccess(for: .audio) { granted in
                        DispatchQueue.main.async {
                            self.diagnostic("microphone-authorization-result", ["granted": granted])
                            if granted { camera() } else { forward() }
                        }
                    }
                } else if status == .authorized { camera() }
                else { forward() }
                return
            }
            if ["finish_voice", "cancel", "submit_text"].contains(type) { voiceRequested = false }
        }
        if !connection.send(payload, generation: epoch) { voiceRequested = false }
    }
    func applyDisplay(proposedModelTop: CGPoint? = nil) {
        guard panel != nil, !applyingDisplay else { return }
        applyingDisplay = true; defer { applyingDisplay = false }
        let model = displayCollapsed ? (collapsedScreenFrame ?? modelScreenFrame ?? panel.frame) : (modelScreenFrame ?? panel.frame)
        let anchor: CGPoint
        if displayCollapsed {
            anchor = proposedModelTop ?? desiredBallTop ?? CGPoint(x:model.midX,y:model.maxY)
            desiredBallTop = anchor
            // Only an explicit ball drag relocates the expanded character.
            if let proposed = proposedModelTop { desiredModelTop = proposed }
        } else {
            desiredBallTop = nil
            anchor = proposedModelTop ?? desiredModelTop ?? CGPoint(x:model.midX,y:model.maxY)
            if let proposed = proposedModelTop { desiredModelTop = proposed }
        }
        let proposedModel = CGRect(x:anchor.x-model.width/2,y:anchor.y-model.height,width:model.width,height:model.height)
        let screen = NSScreen.screens.max { $0.visibleFrame.intersection(proposedModel).area < $1.visibleFrame.intersection(proposedModel).area }
        guard let visible = screen?.visibleFrame else { return }
        let firstPlacement = modelScreenFrame == nil && !displayCollapsed && proposedModelTop == nil
        // Default near the lower-right. This offset is approximate until the
        // visible figure and Dock Trash can be measured in the same coordinate space.
        let layoutAnchor = firstPlacement ? CGPoint(x:visible.maxX-52,y:visible.minY) : anchor
        if firstPlacement { desiredModelTop = layoutAnchor }
        let layout = PetDisplayLayout.fit(width:displayPreferences.width,open:displayOpen,screen:visible,anchor:layoutAnchor,collapsed:displayCollapsed,speechVisible:speechVisible,speechHeight:speechHeight,quickHeight:quickHeight)
        if firstPlacement { diagnostic("initial-placement",["edge":"bottom-right","maxX":layout.frame.maxX,"minY":layout.frame.minY,"screenMaxX":visible.maxX,"screenMinY":visible.minY]) }
        if displayCollapsed { collapsedScreenFrame = layout.ballFrame }
        else { modelScreenFrame = layout.modelFrame; collapsedScreenFrame = nil }
        // The WK viewport stays the size of its screen. Only its clipped native
        // origin changes, in the same non-animated transaction as the window.
        // Opening chat cannot resize/clear a WebGL drawing buffer between frames.
        CATransaction.begin(); CATransaction.setDisableActions(true)
        panel.setFrame(layout.frame,display:false)
        web.setFrameOrigin(layout.webOrigin)
        if web.frame.size != visible.size { web.setFrameSize(visible.size) }
        viewportClip?.layer?.masksToBounds = true
        CATransaction.commit()
        panel.displayIfNeeded()
        var config = layout.configuration
        config["mode"] = displayPreferences.mode; config["preferredWidth"] = displayPreferences.width
        config["rendererKind"] = rendererKind
        deliver("displayConfig",config)
    }
    func windowDidChangeScreen(_ notification: Notification) { applyDisplay() }
    func windowDidChangeBackingProperties(_ notification: Notification) { applyDisplay() }
    func applicationDidChangeScreenParameters(_ notification: Notification) { applyDisplay() }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let u = action.request.url
        let allowed = u?.scheme == "pet" && u?.host == "app" || (u?.scheme == "http" && ["127.0.0.1", "localhost"].contains(u?.host ?? ""))
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let trusted = origin.protocol == "pet" && origin.host == "app" || origin.protocol == "http" && ["127.0.0.1", "localhost"].contains(origin.host)
        diagnostic("media-permission-request", ["voiceRequested": voiceRequested, "trusted": trusted, "type": type.rawValue])
        decisionHandler(trusted && frame.isMainFrame && (voiceRequested || (wakeRequested && type == .microphone)) ? .grant : .deny)
    }
    func windowDidResignKey(_ notification: Notification) { displayPreferences.resize("cancel", width: nil); applyDisplay(); deliver("hotkeyEvent", ["type": "cancel"]) }
    func applicationDidResignActive(_ notification: Notification) { displayPreferences.resize("cancel", width: nil); applyDisplay(); deliver("hotkeyEvent", ["type": "cancel"]) }
    func applicationWillTerminate(_ notification: Notification) {
        managementLauncher.cancel()
        captureTimer?.invalidate(); web?.stopLoading(); connection.close()
    }
}
private extension NSRect { var area: CGFloat { isNull ? 0 : width * height } }
#if !DESKTOP_WORKLET_TEST
let app = NSApplication.shared
let delegate = AppDelegate(); app.delegate = delegate
app.run()
#endif

#endif

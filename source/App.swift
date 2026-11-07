import AppKit
import WebKit
import UniformTypeIdentifiers
import CryptoKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var terminationPending = false
    private var reloadPending = false
    private var pendingReload: (navigation: WKNavigation, token: String)?
    private var departureGeneration = 0
    private let startupPageID = UUID().uuidString
    private var shutdownInspection: NSAlert?
    private var shutdownReport: NSTextView?
    private var shutdownRefresh: NSButton?
    private var shutdownInspectionRefreshing = false
    private let serverInput = Pipe()
    private let accessMode = ToolAccessMode.saved()
    private var recoveryStartup=false
    private let computer = ComputerController()
    private let macAccess = MacAccessController()
    private let instanceToken = UUID().uuidString + UUID().uuidString
    private lazy var tools = NativeToolsController(computer:computer,token:instanceToken,accessMode:accessMode)
    private let home = URL(string: "http://127.0.0.1:8787")!

    private var diagnosticRunning = false
    private var startupStderr = NoieeBoundedCapture()
    private var startupRuntime: NoieeVerifiedRuntime?
    private var startupReportURL: URL?
    private var startupReportSummary = "The startup check has not finished."
    private var startupLifecycle = NoieeStartupLifecycle()
    private var startupTask: Task<Void, Never>?
    private var startupFailureMessage: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.applicationIconImage = NSImage(size: NSSize(width: 1024, height: 1024), flipped: false) { _ in
            NSColor(calibratedRed: 0.14, green: 0.17, blue: 0.16, alpha: 1).setFill()
            NSBezierPath(roundedRect: NSRect(x: 35, y: 35, width: 954, height: 954), xRadius: 220, yRadius: 220).fill()
            ("N" as NSString).draw(in: NSRect(x: 205, y: 115, width: 690, height: 775), withAttributes: [.font: NSFont(name: "Georgia-Italic", size: 690) ?? NSFont.systemFont(ofSize: 690), .foregroundColor: NSColor(calibratedRed: 0.76, green: 0.84, blue: 0.78, alpha: 1)])
            return true
        }
        computer.accessMode = accessMode
        let menu = NSMenu()
        let appItem = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Noiee", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(withTitle: "Mac Access…", action: #selector(showMacAccess), keyEquivalent: ",")
        let accessItem=NSMenuItem(title:"Tool Access (next launch)",action:nil,keyEquivalent:"")
        let accessMenu=NSMenu(title:"Tool Access")
        for mode in [ToolAccessMode.reviewed,.full] {
            let item=accessMenu.addItem(withTitle:mode.label,action:#selector(selectToolAccess(_:)),keyEquivalent:"")
            item.representedObject=mode.rawValue;item.state = ToolAccessMode.saved()==mode ? .on:.off
        }
        accessItem.submenu=accessMenu;appMenu.addItem(accessItem)
        appMenu.addItem(withTitle:"Prepare In-place Recovery…",action:#selector(prepareRecoveryStartup),keyEquivalent:"")
        appMenu.addItem(withTitle:"Cancel Recovery Startup (next launch)",action:#selector(cancelRecoveryStartup),keyEquivalent:"")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Noiee", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; menu.addItem(appItem)
        let fileItem = NSMenuItem(); let file = NSMenu(title: "File")
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file; menu.addItem(fileItem)
        let editItem = NSMenuItem(); let edit = NSMenu(title: "Edit")
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(selector), keyEquivalent: key)
        }
        editItem.submenu = edit; menu.addItem(editItem)
        let viewItem = NSMenuItem(); let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload Chat", action: #selector(reload), keyEquivalent: "r")
        let stopItem = view.addItem(withTitle: "Stop All Agent Work", action: #selector(stopComputer), keyEquivalent: ".")
        stopItem.keyEquivalentModifierMask = [.command, .shift]
        view.addItem(withTitle: "Shutdown Status…", action: #selector(inspectShutdown), keyEquivalent: "")
        viewItem.submenu = view; menu.addItem(viewItem); NSApp.mainMenu = menu
        let diagnosticItem = NSMenuItem(), diagnosticMenu = NSMenu(title: "Diagnostics")
        diagnosticMenu.addItem(withTitle: "Startup Report…", action: #selector(showStartupReport), keyEquivalent: "")
        diagnosticMenu.addItem(withTitle: "Check known Chrome window (read only)", action: #selector(diagnoseChromeWindow), keyEquivalent: "")
        diagnosticItem.submenu = diagnosticMenu; menu.addItem(diagnosticItem)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.addScriptMessageHandler(computer, contentWorld: .page, name: "computer")
        configuration.userContentController.addScriptMessageHandler(tools,contentWorld:.page,name:"tools")
        webView = WKWebView(frame: .zero, configuration: configuration)
        computer.webView = webView
        computer.authenticate = { [weak self] in await self?.ready() == true }
        computer.propose = { [weak self] input in
            guard let self else { throw ComputerError.message("App closed.") }
            return try await self.tools.computerProposal(input)
        }
        tools.webView=webView
        tools.authenticate = { [weak self] in await self?.ready() == true }
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.underPageBackgroundColor = NSColor(calibratedWhite: 0.12, alpha: 1)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.delegate = self
        window.title = "Noiee"
        window.subtitle = accessMode.label + (accessMode == .full ? " · Tools run without approval" : " · Local workspace")
        window.minSize = NSSize(width: 760, height: 580)
        window.backgroundColor = NSColor(calibratedWhite: 0.12, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = webView; window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString("<html><body data-saleh-startup='\(startupPageID)' style='background:#202122;color:#cad3cd;font:15px -apple-system;padding:60px'>Opening your local workspace…</body></html>", baseURL: nil)
        beginStartupIfNeeded()
    }

    private func ready() async -> Bool {
        guard let server, server.isRunning else { return false }
        let challenge = (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
        var request = URLRequest(url: home.appendingPathComponent("api/instance")); request.timeoutInterval = 1
        request.setValue(challenge, forHTTPHeaderField: "X-Qwen-Challenge")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String:String], let proof = json["proof"] else { return false }
        let expected = HMAC<SHA256>.authenticationCode(for: Data(challenge.utf8), using: SymmetricKey(data: Data(instanceToken.utf8))).map { String(format: "%02x", $0) }.joined()
        return proof == expected && server.isRunning
    }

    private func beginStartupIfNeeded() {
        guard startupTask == nil, server == nil, let ticket = startupLifecycle.beginStartup() else { return }
        startupRuntime = nil
        startupFailureMessage = nil
        startupStderr = NoieeBoundedCapture()
        startupTask = Task {
            await start(ticket)
            if startupLifecycle.owns(ticket) { startupTask = nil }
            await presentStartupOutcome()
        }
    }

    private func start(_ ticket: UUID) async {
        guard startupLifecycle.continuePreflight(ticket) else { return }
        guard let resources = Bundle.main.resourceURL else {
            startupFailed(NoieeStartupFailure(.missingResources), phase: "preflight", ticket: ticket); return
        }
        let runtime: NoieeVerifiedRuntime
        do {
            runtime = try await Task.detached(priority: .userInitiated) {
                try NoieeStartupPreflight.prepare(resources: resources)
            }.value
        } catch {
            guard startupLifecycle.continuePreflight(ticket) else { return }
            startupFailed(error as? NoieeStartupFailure ?? NoieeStartupFailure(.runtimeProbeFailed),
                          phase: "preflight", ticket: ticket)
            return
        }
        // Quit revokes launch authority before awaiting this task. No access
        // marker or child can be created after it chooses the no-server branch.
        guard startupLifecycle.authorizeBackendLaunch(ticket) else { return }
        startupRuntime = runtime
        let mutationBlocked:Bool
        do {
            let directory=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Qwen Local/Access",isDirectory:true)
            let request=try ToolAccessMode.recoveryRequest(),state=try accessMode.startup(directory,boot:HandoffProcess.boot(),request:request)
            mutationBlocked=state.unconfinedBoot;recoveryStartup=state.recoveryStartup
            if recoveryStartup {
                computer.holdForRecoveryStartup();tools.holdForRecoveryStartup()
                window.subtitle="Full Access · Recovery startup · Unrestricted tools held"
            } else if request != nil {
                window.subtitle=accessMode.label+" · Recovery prepared · Mac restart required"
            }
        } catch {
            guard startupLifecycle.markFailed(ticket) else { return }
            recordStartup(NoieeStartupFailure(.accessUnavailable), phase: "access", stderr: startupStderr.finish())
            startupFailureMessage = "Tool access could not be verified: " + error.localizedDescription
            return
        }
        let process = Process(); process.executableURL = runtime.executable
        process.arguments = [resources.appendingPathComponent("server.mjs").path]
        process.currentDirectoryURL = resources
        var environment = ProcessInfo.processInfo.environment; environment["QWEN_LOCAL_INSTANCE_TOKEN"] = instanceToken
        environment["QWEN_LOCAL_NATIVE_HELPER"] = Bundle.main.executableURL?.path
        environment["SALEH_TOOL_ACCESS_MODE"] = accessMode.rawValue
        environment["SALEH_UNCONFINED_BOOT"] = mutationBlocked ? "true":"false"
        environment["SALEH_RECOVERY_STARTUP"] = recoveryStartup ? "true":"false"
        process.environment = environment
        process.terminationHandler = { [weak self] child in Task { @MainActor in
            guard let self, self.server === child, self.startupLifecycle.owns(ticket) else { return }
            self.tools.stop()
            if self.startupLifecycle.phase == .ready {
                if self.terminationPending {
                    _ = self.startupLifecycle.markFailed(ticket)
                } else {
                    self.startupFailed(NoieeStartupFailure(.unexpectedBackendExit, exit: child.terminationStatus),
                                       phase: "server-exit", ticket: ticket)
                    await self.presentStartupOutcome()
                }
            }
        } }
        process.standardInput = serverInput
        let errors = Pipe(), capture = startupStderr
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { capture.append(data) }
        }
        process.standardOutput = FileHandle.nullDevice; process.standardError = errors
        do {
            try process.run(); server = process
            try? errors.fileHandleForWriting.close()
        } catch {
            errors.fileHandleForReading.readabilityHandler = nil
            startupFailed(NoieeStartupFailure(.backendExited), phase: "server-launch", ticket: ticket); return
        }
        // An already launched backend completes its bounded readiness check.
        // Quit awaits it and then uses the existing authenticated shutdown path.
        for _ in 0..<30 {
            if await ready() {
                guard process.isRunning, startupLifecycle.markReady(ticket) else { break }
                recordStartup(nil, phase: "ready", stderr: startupStderr.finish())
                return
            }
            if !process.isRunning { break }
            try? await Task.sleep(for: .milliseconds(200))
        }
        guard startupLifecycle.markFailed(ticket) else { return }
        let summary = startupStderr.finish()
        let failure = NoieeStartupPreflight.backendFailure(exited: !process.isRunning,
            status: process.isRunning ? nil : process.terminationStatus, stderr: summary)
        recordStartup(failure, phase: "server-readiness", stderr: summary)
        startupFailureMessage = failure.localizedDescription + "\n\nDiagnostics → Startup Report contains the redacted result."
    }

    private func presentStartupOutcome() async {
        guard !terminationPending, !reloadPending else { return }
        if startupLifecycle.phase == .failed, let message = startupFailureMessage {
            startupFailureMessage = nil
            showError(message)
            return
        }
        guard let permit = startupLifecycle.beginNavigation(generation: departureGeneration) else { return }
        let script = """
        Boolean(location.href === 'about:blank' && document.body?.dataset.salehStartup === '\(startupPageID)' &&
                document.body.childElementCount === 0 && document.body.textContent === 'Opening your local workspace…' &&
                !window.__salehDraftDeparture)
        """
        let startupDocument = (try? await webView.evaluateJavaScript(script)) as? Bool == true
        guard startupLifecycle.finishNavigation(permit, generation: departureGeneration,
            startupDocument: startupDocument,
            blocked: terminationPending || reloadPending || server?.isRunning != true) else { return }
        // No suspension between committing this permit and asking WebKit to
        // navigate; a later Quit uses the unchanged document-generation guard.
        webView.load(URLRequest(url: home))
    }

    private func recordStartup(_ failure: NoieeStartupFailure?, phase: String, stderr: NoieeStderrSummary) {
        let rawBuild = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        let build = rawBuild.range(of: "^[0-9]{1,12}$", options: .regularExpression) != nil ? rawBuild : "development"
        let receipt = NoieeStartupReceipt(recordedAt: ISO8601DateFormatter().string(from: Date()),
            build: build, outcome: failure == nil ? "ready" : "failed", phase: phase,
            failureCode: failure?.code, exitStatus: failure?.exitStatus,
            requiredNodeVersion: failure?.requiredVersion ?? startupRuntime?.version,
            observedNodeVersion: failure?.observedVersion ?? startupRuntime?.version,
            nodeExecutableSHA256: startupRuntime?.executableSHA256,
            runtimeContractSHA256: startupRuntime?.contractSHA256, stderr: failure?.runtimeDiagnostics ?? stderr)
        startupReportSummary = failure?.localizedDescription ?? "Noiee confirmed its local server and qualified Node runtime."
        if let failure { startupReportSummary += "\nCategory: \(failure.code.rawValue)." }
        if let status = failure?.exitStatus { startupReportSummary += "\nExit status: \(status)." }
        if let runtime = startupRuntime { startupReportSummary += "\nNode runtime: \(runtime.version)." }
        do { startupReportURL = try NoieeStartupReports.write(receipt) }
        catch { startupReportURL = nil; startupReportSummary += "\nThe support receipt could not be saved." }
    }

    private func startupFailed(_ failure: NoieeStartupFailure, phase: String, ticket: UUID) {
        guard startupLifecycle.markFailed(ticket) else { return }
        recordStartup(failure, phase: phase, stderr: startupStderr.finish())
        startupFailureMessage = failure.localizedDescription + "\n\nOpen Diagnostics → Startup Report for the redacted result."
    }

    @objc private func showStartupReport() {
        let alert = NSAlert(); alert.messageText = "Noiee Startup Report"
        alert.informativeText = startupReportSummary + "\n\nReports contain startup categories and runtime metadata. Raw diagnostics, prompts, credentials and tool output are omitted."
        alert.addButton(withTitle: "Close")
        if startupReportURL != nil { alert.addButton(withTitle: "Show Receipt in Finder") }
        if alert.runModal() == .alertSecondButtonReturn, let url = startupReportURL {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert(); alert.messageText = "Noiee"; alert.informativeText = message
        alert.addButton(withTitle: "OK"); alert.runModal()
    }

    @objc private func prepareRecoveryStartup() {
        guard !recoveryStartup else {showError("Recovery startup is already active. Its request was kept; unrestricted tools remain held.");return}
        do {
            try ToolAccessMode.armRecovery(boot:HandoffProcess.boot())
            window.subtitle=accessMode.label+" · Recovery prepared · Mac restart required"
            let notice=NSAlert();notice.messageText="Recovery startup prepared"
            notice.informativeText="Full Access stays selected. Restart your Mac when ready, then open Noiee. Unrestricted tools will be held while the retained recovery is inspected and completed. Your saved chats and drafts stay in place. This request does not complete recovery or restart the Mac."
            notice.addButton(withTitle:"OK");notice.runModal()
        } catch {showError(error.localizedDescription)}
    }

    @objc private func cancelRecoveryStartup() {
        UserDefaults.standard.removeObject(forKey:ToolAccessMode.recoveryKey)
        window.subtitle=accessMode.label+(recoveryStartup ? " · Recovery hold remains until quit":" · Recovery startup canceled for next launch")
        let notice=NSAlert();notice.messageText="Recovery startup canceled for next launch"
        notice.informativeText="The running tool policy is unchanged. After a normal quit and relaunch, the saved tool-access selection applies. Retained handoffs, chats and drafts remain protected; cancellation does not complete recovery."
        notice.addButton(withTitle:"OK");notice.runModal()
    }

    @objc private func selectToolAccess(_ sender:NSMenuItem) {
        guard let raw=sender.representedObject as? String,let mode=ToolAccessMode(rawValue:raw) else {return}
        UserDefaults.standard.set(mode.rawValue,forKey:ToolAccessMode.preferenceKey)
        for item in sender.menu?.items ?? [] {item.state = item===sender ? .on:.off}
        window.subtitle = "Current: "+accessMode.label+(recoveryStartup ? " · Recovery startup · Tools held":"")+" · Next launch: "+mode.label
    }
    @objc private func about() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown version"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"
        let alert = NSAlert(); alert.messageText = "Noiee \(version) — Build \(build)"
        alert.informativeText = "Qwen in LM Studio is the default model. Coding adds project chats, commands, saved history and Git changes through the installed Codex engine. Optional cloud providers are used only when you select them for a new coding chat; that chat and its project context are sent to the selected provider.\n\nAgent mode retains native computer tools and explicitly connected MCP servers. Tool access: \(accessMode.label). Full Access runs operational tools without app approval and allows file/network access as your Mac user. macOS permissions, required input choices and recovery restrictions still apply. Change tool access in the app menu; it takes effect after a normal quit and relaunch. To prepare retained in-place recovery, choose Prepare In-place Recovery in the app menu and restart the Mac. Full Access stays selected while recovery startup holds unrestricted tools. Original identity and owner checks still apply."
        alert.runModal()
    }
    @objc private func stopComputer() { tools.stop() }
    @objc private func diagnoseChromeWindow() {
        guard !recoveryStartup else {showError(RecoveryStartupPolicy.message);return}
        guard !diagnosticRunning else { return }
        diagnosticRunning = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.diagnosticRunning = false }
            var result: [String:Any]
            do { result = try await self.computer.diagnoseChromeWindow() }
            catch { result = ["status":"refused", "message":error.localizedDescription] }
            result["observed_at"] = ISO8601DateFormatter().string(from:Date())
            result["build"] = Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? ""
            result["controller_bundle_id"] = Bundle.main.bundleIdentifier ?? ""
            result["screenshots"] = false
            result["input_sent"] = false
            result["permissions_changed"] = false
            let output = NoieeStartupReports.defaultRoot
                .appendingPathComponent("chrome-window-" + UUID().uuidString + ".json")
            var saved = false
            do {
                let data = try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys])
                try data.write(to:output,options:.withoutOverwriting)
                saved = true
            } catch { }
            let alert = NSAlert(); alert.messageText = "Chrome window diagnostic"
            let status = result["status"] as? String ?? "unknown"
            let message = result["message"] as? String ?? result["reason"] as? String ?? "Check the saved receipt for the result."
            alert.informativeText = "Result: \(status).\n\(message)\n\nNo screenshot or input was sent.\n" + (saved ? "Receipt: \(output.path)" : "The receipt could not be saved.")
            alert.addButton(withTitle:"Close")
            _ = await alert.beginSheetModal(for:self.window)
        }
    }
    @objc private func inspectShutdown() { showShutdownInspection() }
    private func showShutdownInspection() {
        if let dialog=shutdownInspection { dialog.buttons.first?.isEnabled = !terminationPending; refreshShutdownInspection(); return }
        let dialog=NSAlert(); dialog.messageText="Shutdown Status"
        dialog.informativeText="Read-only inspection. Refresh does not retry cleanup or release retained ownership."
        dialog.addButton(withTitle:"Close").isEnabled = !terminationPending
        let accessory=NSView(frame:NSRect(x:0,y:0,width:650,height:410))
        let scroll=NSScrollView(frame:NSRect(x:0,y:40,width:650,height:370)); scroll.hasVerticalScroller=true; scroll.borderType = .bezelBorder
        let text=NSTextView(frame:scroll.bounds); text.isEditable=false; text.isSelectable=true; text.font = .monospacedSystemFont(ofSize:12,weight:.regular)
        text.string="Inspecting shutdown…"; text.autoresizingMask = [.width]; text.textContainer?.widthTracksTextView=true; text.setAccessibilityLabel("Shutdown status and saved snapshots")
        scroll.documentView=text; accessory.addSubview(scroll)
        let refresh=NSButton(title:"Refresh",target:self,action:#selector(refreshShutdownInspection)); refresh.frame=NSRect(x:540,y:0,width:110,height:32); accessory.addSubview(refresh)
        dialog.accessoryView=accessory; shutdownInspection=dialog; shutdownReport=text; shutdownRefresh=refresh
        dialog.beginSheetModal(for:window) { [weak self,weak dialog] _ in
            guard let self, self.shutdownInspection === dialog else { return }
            self.shutdownInspection=nil; self.shutdownReport=nil; self.shutdownRefresh=nil
        }
        refreshShutdownInspection()
    }
    @objc private func refreshShutdownInspection() {
        guard !shutdownInspectionRefreshing, let text=shutdownReport else { return }
        shutdownInspectionRefreshing=true; shutdownRefresh?.isEnabled=false
        Task {
            let report=await tools.shutdownStatus()
            if shutdownReport === text { text.string=report }
            shutdownInspectionRefreshing=false; shutdownRefresh?.isEnabled=true
            if let current=shutdownReport, current !== text { refreshShutdownInspection() }
        }
    }
    private func dismissShutdownInspection() {
        if let dialog=shutdownInspection, let parent=dialog.window.sheetParent { parent.endSheet(dialog.window) }
        shutdownInspection=nil; shutdownReport=nil; shutdownRefresh=nil
    }
    @objc private func showMacAccess() { macAccess.show() }
    // DRAFT DEPARTURE BEGIN
    private func departureScript(_ token: String, finishing: Bool, pagehide: Bool) -> String {
        """
        const token = '\(token)';
        const finishing = \(finishing ? "true" : "false");
        const pagehide = \(pagehide ? "true" : "false");
        const page = document, body = page.body, href = location.href;
        const previous = window.__salehDraftDeparture;
        if (!body || (finishing ? !previous || previous.token !== token || previous.body !== body || previous.page !== page || previous.href !== href : !!previous)) return false;
        const held = finishing ? previous : {token, body, page, href, inert: body.inert};
        const inert = held.inert;
        if (!finishing) window.__salehDraftDeparture = held;
        body.inert = true;
        let saved = false;
        try {
          const save = window.salehSaveBeforeLeave;
          const startup = href === 'about:blank' && body.dataset.salehStartup === '\(startupPageID)' && body.childElementCount === 0 && body.textContent === 'Opening your local workspace…';
          if (typeof save === 'function' ? await save() !== true : !startup) return false;
          if (window.__salehDraftDeparture !== held || held.token !== token || held.body !== body || held.page !== page || document !== page || document.body !== body || location.href !== href) return false;
          if (finishing && pagehide) window.dispatchEvent(new Event('pagehide'));
          saved = true;
          return true;
        } finally {
          if (!saved) {
            body.inert = inert;
            if (window.__salehDraftDeparture === held && held.token === token) delete window.__salehDraftDeparture;
          }
        }
        """
    }
    private func releaseDepartureScript(_ token: String) -> String {
        """
        (() => {
          const held = window.__salehDraftDeparture;
          if (held?.token === '\(token)') {
            held.body.inert = held.inert;
            delete window.__salehDraftDeparture;
          }
        })()
        """
    }
    private func saveForDeparture(_ token: String, generation: Int, finishing: Bool = false, pagehide: Bool = true) async throws {
        guard generation == departureGeneration else { throw ComputerError.message("The page changed before it could be saved. Try again.") }
        let result = try await webView.callAsyncJavaScript(departureScript(token, finishing: finishing, pagehide: pagehide), arguments: [:], in: nil, contentWorld: .page)
        guard generation == departureGeneration, result as? Bool == true else {
            throw ComputerError.message("Your draft could not be saved. This window is staying open. Copy any unsent text, then retry.")
        }
    }
    @objc private func reload() {
        guard !terminationPending, !reloadPending else { return }
        reloadPending = true
        let token = UUID().uuidString, generation = departureGeneration
        Task {
            do {
                try await saveForDeparture(token, generation: generation)
                tools.departPage()
                try await saveForDeparture(token, generation: generation, finishing: true, pagehide: false)
                guard let navigation = webView.reload() else { throw ComputerError.message("The page could not reload. Your saved draft remains in this window.") }
                pendingReload = (navigation, token)
            } catch {
                await restoreReload(token, error: error)
            }
        }
    }
    private func restoreReload(_ token: String, error: Error?) async {
        _ = try? await webView.evaluateJavaScript(releaseDepartureScript(token))
        reloadPending = false
        if let error { window?.makeKeyAndOrderFront(nil); showError(error.localizedDescription) }
        await presentStartupOutcome()
    }
    private func completeReload(_ navigation: WKNavigation?, error: Error? = nil) {
        guard let pending = pendingReload, pending.navigation === navigation else { return }
        pendingReload = nil
        Task { await restoreReload(pending.token, error: error) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // A completed document invalidates an evaluation begun before its body
        // existed. Its fresh permit cannot be consumed by that older reply.
        startupLifecycle.invalidateNavigation()
        completeReload(navigation)
        Task { await presentStartupOutcome() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { completeReload(navigation, error: error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { completeReload(navigation, error: error) }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === window else { return true }
        if !terminationPending && !reloadPending { NSApp.terminate(nil) }
        return false
    }
    func windowWillClose(_ notification: Notification) { macAccess.close(); tools.stopTools() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminationPending { return .terminateLater }
        if reloadPending { return .terminateCancel }
        guard let quitTicket = startupLifecycle.beginQuit() else { return .terminateLater }
        terminationPending = true
        let token = UUID().uuidString, generation = departureGeneration
        let pendingStartup = startupTask
        Task {
            // Startup either pauses before all access/backend mutation, or
            // finishes its bounded readiness check for the existing shutdown.
            await pendingStartup?.value
            do {
                try await saveForDeparture(token, generation: generation)
                showShutdownInspection()
                if let server, server.isRunning {
                    try await tools.shutdown()
                    try await saveForDeparture(token, generation: generation, finishing: true)
                    try serverInput.fileHandleForWriting.close()
                    let exited = await Task.detached {
                        server.waitUntilExit()
                        return server.terminationReason == .exit && server.terminationStatus == 0
                    }.value
                    guard exited else { throw ComputerError.message("The local server exited without confirming shutdown.") }
                } else {
                    tools.stop()
                    try await saveForDeparture(token, generation: generation, finishing: true)
                }
                guard startupLifecycle.completeQuit(quitTicket) else {
                    throw ComputerError.message("Startup state changed during shutdown. This window is staying open.")
                }
                dismissShutdownInspection()
                NSApp.reply(toApplicationShouldTerminate: true)
            } catch {
                _ = try? await webView.evaluateJavaScript(releaseDepartureScript(token))
                dismissShutdownInspection()
                guard let resume = startupLifecycle.cancelQuit(quitTicket) else { return }
                terminationPending = false
                NSApp.reply(toApplicationShouldTerminate: false)
                window?.makeKeyAndOrderFront(nil)
                showError(error.localizedDescription)
                if resume == .restart { beginStartupIfNeeded() }
                await presentStartupOutcome()
            }
        }
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) { try? serverInput.fileHandleForWriting.close() }
    // DRAFT DEPARTURE END

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.navigationType == .linkActivated, ["http", "https"].contains(url.scheme ?? ""), url.user == nil, url.password == nil {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        if action.targetFrame?.isMainFrame == true { departureGeneration += 1; startupLifecycle.invalidateNavigation(); tools.departPage() }
        let local = url.scheme == "http" && url.host == "127.0.0.1" && url.port == 8787
        if action.shouldPerformDownload && url.scheme == "blob" { decisionHandler(.download) }
        else { decisionHandler(local || url.scheme == "about" ? .allow : .cancel) }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "Noiee"; alert.informativeText = message
        alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Delete")
        completionHandler(alert.runModal() == .alertSecondButtonReturn)
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.message = "Choose text or PNG/JPEG attachments, or a Noiee chat backup to restore."
        completionHandler(panel.runModal() == .OK ? panel.urls : nil)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename; panel.allowedContentTypes = [.json]
        panel.message = "Save a backup of your Noiee conversations. Tasks histories are not included."
        completionHandler(panel.runModal() == .OK ? panel.url : nil)
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if (error as NSError).code != NSURLErrorCancelled { showError("The export could not be saved: \(error.localizedDescription)") }
    }
}

@main
struct QwenLocal {
    @MainActor static func main() {
        if CommandLine.arguments.dropFirst().first == "--coding-temp" { exit(CodingTemporary.command(CommandLine.arguments)) }
        if CommandLine.arguments.dropFirst().first == "--handoff-files" { exit(HandoffFiles.command(CommandLine.arguments)) }
        if CommandLine.arguments.dropFirst().first == "--handoff-process" { exit(HandoffProcess.command(CommandLine.arguments)) }
        if CommandLine.arguments.contains("--check-computer") { do { try ComputerAction.check(); PhoneTarget.check(); RoutineReadPolicy.check(); ToolAccessMode.check() } catch { fatalError(error.localizedDescription) }; return }
        let application = NSApplication.shared; let delegate = AppDelegate()
        application.setActivationPolicy(.regular); application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}

import AppKit
import ApplicationServices

enum MacAccessCapability: Int, CaseIterable {
    case accessibility, screenCapture, filesAndFolders, fullDiskAccess

    var title: String {
        switch self {
        case .accessibility: return "Accessibility"
        case .screenCapture: return "Screen & System Audio Recording"
        case .filesAndFolders: return "Files & Folders"
        case .fullDiskAccess: return "Full Disk Access"
        }
    }
    var detail: String {
        switch self {
        case .accessibility: return "Lets Agent read app controls and perform clicks, typing and keyboard actions under your selected tool access mode. Choose Noiee in this settings pane."
        case .screenCapture: return "Lets Agent list app windows and capture the window or display you select. These computer tools capture screenshots, not audio. You can also choose a window with Share."
        case .filesAndFolders: return "Review access to Documents, Desktop, Downloads and other protected locations. Choose a project or connect a folder in the app for the task you want to do. Access may be requested when that location is used."
        case .fullDiskAccess: return "Optional broad access to protected files, including other apps’ data and backups. To enable it, add this installed Noiee app and turn it on yourself. This panel does not read private files to test access."
        }
    }
    var settingsURL: URL {
        let pane: String
        switch self {
        case .accessibility: pane = "Privacy_Accessibility"
        case .screenCapture: pane = "Privacy_ScreenCapture"
        case .filesAndFolders: pane = "Privacy_FilesAndFolders"
        case .fullDiskAccess: pane = "Privacy_AllFiles"
        }
        // Fixed, best-effort navigation links only. macOS owns the actual grants.
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!
    }
}

enum MacAccessPermissionStatus: Equatable {
    case granted, notGranted, reviewInSettings

    var title: String {
        switch self {
        case .granted: return "Granted"
        case .notGranted: return "Not currently granted"
        case .reviewInSettings: return "Review in System Settings"
        }
    }
}

struct MacAccessSnapshot {
    let accessibility: Bool
    let screenCapture: Bool

    func status(for capability: MacAccessCapability) -> MacAccessPermissionStatus {
        switch capability {
        case .accessibility: return accessibility ? .granted : .notGranted
        case .screenCapture: return screenCapture ? .granted : .notGranted
        case .filesAndFolders, .fullDiskAccess: return .reviewInSettings
        }
    }
}

/// A read-only status model. There is deliberately no request/grant permission API.
/// Do not expose settings navigation to model tools or the web message bridge.
@MainActor
final class MacAccessModel {
    static let privacySettingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security")!
    private let accessibility: () -> Bool
    private let screenCapture: () -> Bool
    private let openURL: (URL) -> Bool

    init(accessibility: @escaping () -> Bool = { AXIsProcessTrusted() },
         screenCapture: @escaping () -> Bool = { CGPreflightScreenCaptureAccess() },
         openURL: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) }) {
        self.accessibility = accessibility
        self.screenCapture = screenCapture
        self.openURL = openURL
    }

    func refresh() -> MacAccessSnapshot {
        MacAccessSnapshot(accessibility: accessibility(), screenCapture: screenCapture())
    }

    /// Called only by a native settings button, never by render/refresh or a task.
    /// Success means navigation was accepted, not that a permission was granted.
    func openSettings(for capability: MacAccessCapability) -> String? {
        if openURL(capability.settingsURL) { return nil }
        if openURL(Self.privacySettingsURL) {
            return "Choose \(capability.title) in Privacy & Security. macOS may require you to reopen the app after a change."
        }
        return "macOS could not open Settings. Open System Settings → Privacy & Security → \(capability.title) yourself."
    }
}

@MainActor
private final class MacAccessStackView: NSStackView {
    override var isFlipped: Bool { true }
}

@MainActor
final class MacAccessController: NSWindowController {
    private let model: MacAccessModel
    private var panelBuilt = false
    private var statusLabels: [MacAccessCapability: NSTextField] = [:]
    private var navigationMessage: NSTextField?

    init(model: MacAccessModel? = nil) {
        self.model = model ?? MacAccessModel()
        super.init(window: nil)
    }
    required init?(coder: NSCoder) { nil }

    func show() {
        if !panelBuilt { loadWindow() }
        refreshStatus()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    override func loadWindow() {
        guard !panelBuilt else { return }
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 740),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "Mac Access"
        panel.minSize = NSSize(width: 560, height: 440)
        panel.isReleasedWhenClosed = false
        panel.center()

        let root = NSView()
        panel.contentView = root
        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        root.addSubview(scroll)
        let stack = MacAccessStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = stack
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: root.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)
        ])

        func add(_ view: NSView) {
            stack.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48).isActive = true
        }
        add(label("Mac access for your tasks", font: .systemFont(ofSize: 23, weight: .semibold)))
        add(label("Enable each capability in macOS when you want to use it. Opening this panel only checks existing Accessibility and screen access. It does not request or change permissions.", color: .secondaryLabelColor))
        for capability in MacAccessCapability.allCases {
            let group = NSStackView()
            group.orientation = .vertical
            group.alignment = .leading
            group.spacing = 7
            let header = NSStackView()
            header.orientation = .horizontal
            header.spacing = 12
            let heading = label(capability.title, font: .systemFont(ofSize: 15, weight: .semibold))
            header.addArrangedSubview(heading)
            let spacer = NSView()
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
            header.addArrangedSubview(spacer)
            let button = NSButton(title: "Open Settings…", target: self, action: #selector(openSettings(_:)))
            button.tag = capability.rawValue
            button.toolTip = "System Settings → Privacy & Security → \(capability.title)"
            button.setAccessibilityLabel("Open \(capability.title) settings")
            header.addArrangedSubview(button)
            group.addArrangedSubview(header)
            let status = label("Not checked", font: .systemFont(ofSize: 12, weight: .medium), color: .secondaryLabelColor)
            status.setAccessibilityLabel("\(capability.title) status")
            statusLabels[capability] = status
            group.addArrangedSubview(status)
            let detail = label(capability.detail)
            group.addArrangedSubview(detail)
            add(group)
            header.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
            detail.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
        }
        let separator = NSBox()
        separator.boxType = .separator
        add(separator)
        add(label("Scope stays under your control", font: .systemFont(ofSize: 15, weight: .semibold)))
        add(label("Mac permissions do not change configured Coding project, VM or MCP restrictions. Agent commands run as your Mac user. The tool access mode controls app confirmations: Full Access skips operational confirmations; required choices and recovery restrictions still apply. Automation is only needed when an app action requires it; these native computer controls do not use it. Contacts access is requested separately when you choose to call a contact.", color: .secondaryLabelColor))
        add(label("To revoke access, open the matching settings pane and turn off Noiee. Stop in the app ends its current computer session; it does not revoke macOS permissions. Relaunch the app if macOS asks, then click Refresh Status.", color: .secondaryLabelColor))
        add(label("App: \(Bundle.main.bundleURL.path)", font: .monospacedSystemFont(ofSize: 11, weight: .regular), color: .secondaryLabelColor))
        let message = label("", color: .secondaryLabelColor)
        message.setAccessibilityLabel("Settings navigation status")
        navigationMessage = message
        add(message)
        let refresh = NSButton(title: "Refresh Status", target: self, action: #selector(refreshClicked))
        stack.addArrangedSubview(refresh)
        self.window = panel
        panelBuilt = true
    }

    private func label(_ text: String, font: NSFont = .systemFont(ofSize: 13), color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = font
        field.textColor = color
        field.isSelectable = true
        field.setContentCompressionResistancePriority(.required, for: .vertical)
        return field
    }

    private func refreshStatus() {
        let snapshot = model.refresh()
        for capability in MacAccessCapability.allCases {
            let state = snapshot.status(for: capability)
            statusLabels[capability]?.stringValue = state.title
            statusLabels[capability]?.textColor = state == .granted ? .systemGreen : .secondaryLabelColor
        }
    }
    @objc private func refreshClicked() {
        navigationMessage?.stringValue = "Status refreshed. File permissions are reviewed in System Settings."
        refreshStatus()
    }
    @objc private func openSettings(_ sender: NSButton) {
        guard let capability = MacAccessCapability(rawValue: sender.tag) else { return }
        navigationMessage?.stringValue = model.openSettings(for: capability)
            ?? "Settings opened. Review \(capability.title) there, then return and refresh. Opening Settings does not grant access."
    }
}

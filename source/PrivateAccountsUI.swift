import AppKit

@MainActor final class PrivateAccountsDocumentView:NSView {override var isFlipped:Bool {true}}

// Native menu only: no JavaScript action, deep link or model input starts grants.
@MainActor final class PrivateAccountsUI:NSObject,NSWindowDelegate {
    private let session:GitHubAccountSession
    private let gmailUI:GmailAccountUI
    private let driveUI:DriveAccountUI
    private var panel:NSWindow?,work:Task<Void,Never>?,sheet:NSAlert?,generation=UUID()
    private let slug=NSTextField(),client=NSTextField(),status=NSTextField(wrappingLabelWithString:""),code=NSTextField(labelWithString:"")
    private var connectButton:NSButton?,disconnectButton:NSButton?,verifyButton:NSButton?
    init(session:GitHubAccountSession,gmail:GmailAccountSession,drive:DriveAccountSession) {self.session=session;gmailUI=GmailAccountUI(session:gmail);driveUI=DriveAccountUI(session:drive)}
    func show() {
        if let panel {panel.makeKeyAndOrderFront(nil);NSApp.activate();return}
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:650,height:740),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        window.title="Private Accounts";window.minSize=NSSize(width:650,height:740);window.isReleasedWhenClosed=false;window.delegate=self
        let scroll=NSScrollView(frame:window.contentView!.bounds);scroll.autoresizingMask=[.width,.height];scroll.hasVerticalScroller=true;scroll.drawsBackground=false;window.contentView!.addSubview(scroll)
        let document=PrivateAccountsDocumentView(frame:NSRect(x:0,y:0,width:scroll.contentSize.width,height:1000));document.autoresizingMask=[.width];scroll.documentView=document
        let content=NSStackView();content.orientation = .vertical;content.alignment = .leading;content.spacing=12;content.translatesAutoresizingMaskIntoConstraints=false
        document.addSubview(content)
        NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo:document.leadingAnchor,constant:22),content.trailingAnchor.constraint(equalTo:document.trailingAnchor,constant:-22),content.topAnchor.constraint(equalTo:document.topAnchor,constant:22)])
        func label(_ text:String) {let field=NSTextField(wrappingLabelWithString:text);content.addArrangedSubview(field);field.widthAnchor.constraint(equalTo:content.widthAnchor).isActive=true}
        label("GitHub App · read-only repository metadata and issues")
        label("Register and install your GitHub App first. Enable device flow. Allow only Metadata: Read and Issues: Read, with selected repositories. Enter public registration details, never a client secret or token.")
        slug.placeholderString="Registered GitHub App slug";client.placeholderString="Registered GitHub App client ID"
        for field in [slug,client] {content.addArrangedSubview(field);field.widthAnchor.constraint(equalTo:content.widthAnchor).isActive=true}
        let row=NSStackView();row.orientation = .horizontal;row.spacing=10
        func button(_ title:String,_ selector:Selector)->NSButton {let b=NSButton(title:title,target:self,action:selector);row.addArrangedSubview(b);return b}
        connectButton=button("Connect GitHub…",#selector(connect));disconnectButton=button("Disconnect locally…",#selector(disconnect));_ = button("Cancel work",#selector(cancelWork))
        content.addArrangedSubview(row)
        code.font = .monospacedSystemFont(ofSize:22,weight:.medium);content.addArrangedSubview(code)
        let verify=NSButton(title:"Open GitHub verification",target:self,action:#selector(openVerification));verify.isEnabled=false;verifyButton=verify;content.addArrangedSubview(verify)
        status.stringValue="No account setup runs until you choose Connect. A previously saved, verified grant can restore automatically when Agent reads it."
        content.addArrangedSubview(status);status.widthAnchor.constraint(equalTo:content.widthAnchor).isActive=true
        let revoke=NSButton(title:"How to revoke access on GitHub",target:self,action:#selector(openRevocationHelp));content.addArrangedSubview(revoke)
        label("Disconnect removes this app's local tokens, not GitHub's authorization. To revoke the remote grant, open GitHub Settings → Applications → Authorized GitHub Apps and revoke this registered app yourself.")
        content.addArrangedSubview(NSButton(title:"Configure Gmail…",target:self,action:#selector(showGmail)))
        content.addArrangedSubview(NSButton(title:"Configure Drive…",target:self,action:#selector(showDrive)))
        label("Gmail and Drive use separate native Google consent. Drive requires files selected through Google’s browser Picker.")
        panel=window;window.center();window.makeKeyAndOrderFront(nil);NSApp.activate()
    }
    func cancel() {
        generation=UUID();work?.cancel();session.cancel();gmailUI.cancel();driveUI.cancel();code.stringValue="";verifyButton?.isEnabled=false
        if let sheet,let owner=sheet.window.sheetParent {owner.endSheet(sheet.window,returnCode:.abort)}
        sheet=nil
    }
    @objc private func cancelWork() {cancel();status.stringValue=GitHubAccountError.cancelled.localizedDescription}
    func windowWillClose(_ notification:Notification) {cancel();panel=nil}
    private func check(_ expected:UUID)throws {guard expected==generation,!Task.isCancelled,panel != nil else {throw GitHubAccountError.cancelled}}
    private func review(_ title:String,detail:String,button:String,expected:UUID,accessory:NSView?=nil)async throws->Bool {
        try check(expected);guard let panel,sheet==nil else {throw GitHubAccountError.busy}
        let alert=NSAlert();alert.messageText=title;alert.addButton(withTitle:"Cancel");alert.addButton(withTitle:button)
        if let accessory {alert.informativeText=detail;alert.accessoryView=accessory}
        else {
            alert.informativeText="Review the exact account access below. Full Access never skips this choice."
            let scroll=NSScrollView(frame:NSRect(x:0,y:0,width:540,height:240));scroll.hasVerticalScroller=true
            let text=NSTextView(frame:scroll.bounds);text.isEditable=false;text.isSelectable=true;text.string=detail;text.font = .systemFont(ofSize:13);text.autoresizingMask=[.width];text.textContainer?.widthTracksTextView=true;scroll.documentView=text;alert.accessoryView=scroll
        }
        sheet=alert
        let answer=await withCheckedContinuation {continuation in alert.beginSheetModal(for:panel) {continuation.resume(returning:$0)}}
        if sheet===alert {sheet=nil};try check(expected);return answer == .alertSecondButtonReturn
    }
    private func start(_ action:@escaping(UUID)async throws->String) {
        guard work==nil else {return};let expected=generation
        connectButton?.isEnabled=false;disconnectButton?.isEnabled=false
        work=Task {
            defer {work=nil;connectButton?.isEnabled=true;disconnectButton?.isEnabled=true;code.stringValue="";verifyButton?.isEnabled=false}
            do {let result=try await action(expected);try check(expected);status.stringValue=result}
            catch {if expected==generation {status.stringValue=(error as? GitHubAccountError)?.localizedDescription ?? "Private-account operation failed; no credential details were displayed."}}
        }
    }
    @objc private func connect() {
        guard work==nil else {return}
        let registration:GitHubAccountRegistration
        do {registration=try .init(slug:slug.stringValue.trimmingCharacters(in:.whitespacesAndNewlines),clientID:client.stringValue.trimmingCharacters(in:.whitespacesAndNewlines))}
        catch {status.stringValue=GitHubAccountError.configuration.localizedDescription;return}
        status.stringValue="Checking registered GitHub App permissions…"
        start {expected in
            try await self.session.connect(registration,consent:{app in
                try await self.review("Authorize this GitHub App?",detail:"GitHub App: \(app.registration.slug)\nApp ID: \(app.id)\nClient ID: \(app.registration.clientID)\n\nOnly Metadata: Read and Issues: Read are permitted. GitHub will ask you to authorize this app in your browser. You must enter its device code yourself. Noiee will then show the verified account and selected repositories before saving any tokens. Cancel may leave a GitHub authorization already granted; remote revocation is performed in GitHub Settings.",button:"Start device authorization",expected:expected)
            },displayCode:{value,expires in
                guard expected==self.generation else {return};self.code.stringValue=value;self.verifyButton?.isEnabled=true
                self.status.stringValue="Enter this code yourself at https://github.com/login/device. Expires at \(expires.formatted(date:.omitted,time:.shortened)). Keep this window open; Cancel stops local polling."
            },choose:{installations in
                self.code.stringValue="";self.verifyButton?.isEnabled=false
                let picker=NSPopUpButton(frame:NSRect(x:0,y:0,width:500,height:30));picker.addItems(withTitles:installations.map {"\($0.owner.login) · installation \($0.id)"})
                guard try await self.review("Choose the GitHub installation",detail:"Only verified selected-repository, read-only installations are shown. You will review the full repository list next.",button:"Review selected installation",expected:expected,accessory:picker),installations.indices.contains(picker.indexOfSelectedItem) else {return nil}
                return installations[picker.indexOfSelectedItem].id
            },approve:{selection in
                try await self.review("Allow these GitHub reads?",detail:"Authenticated account: \(selection.user.login) (ID \(selection.user.id))\nApp: \(selection.registration.slug) (ID \(selection.appID))\nInstallation owner: \(selection.installation.owner.login)\n\nRepositories:\n"+selection.repositories.map {"• \($0.name) (ID \($0.id))"}.joined(separator:"\n")+"\n\nAllow Noiee to read metadata and issue/PR summaries for exactly these repositories when you use Agent. Returned data goes to Agent's selected local model through its loopback LM Studio connection and this app's saved conversation. Cloud Coding chats do not receive this connector; a future cloud account-tool destination needs a separate grant. Content cannot grant more access. Tokens stay in this Mac's Keychain. This grant survives app restart and allows automatic token refresh and reads within the same verified account and repository IDs. Verified names can update; removed repository IDs stay excluded. New repository IDs require a new native grant. No sending, writes, cloning or publishing is enabled. Disconnect locally here; revoke remote authorization yourself in GitHub Settings.",button:"Allow and save access",expected:expected)
            })
            return "GitHub account access saved. Agent can now read only the approved repository metadata and issue summaries."
        }
    }
    @objc private func disconnect() {
        start {expected in
            guard try await self.review("Disconnect GitHub locally?",detail:"Remove Noiee's local GitHub access and refresh tokens and block future reads. A non-secret disconnected record is retained to prevent automatic restore. This does not revoke the GitHub authorization or affect the separate Git publishing connection.",button:"Disconnect locally",expected:expected) else {return "Local disconnect cancelled."}
            try self.session.disconnect()
            return "Local GitHub tokens removed and reads blocked. Remote GitHub authorization remains until you revoke it in GitHub Settings → Applications → Authorized GitHub Apps."
        }
    }
    @objc private func showDrive() {driveUI.show()}
    @objc private func showGmail() {gmailUI.show()}
    @objc private func openVerification() {guard verifyButton?.isEnabled==true,work != nil else {return};_ = NSWorkspace.shared.open(URL(string:"https://github.com/login/device")!)}
    @objc private func openRevocationHelp() {_ = NSWorkspace.shared.open(URL(string:"https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps")!)}
}

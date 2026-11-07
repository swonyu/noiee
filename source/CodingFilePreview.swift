import AppKit
import Darwin
import ImageIO
import PDFKit
import UniformTypeIdentifiers

// Read a current snapshot only. No execution, URL loading, file writes or access grants.
enum CodingFilePreview {
    enum Kind: String { case text, markdown, image, pdf }
    struct Snapshot {
        let project: String, relativePath: String, data: Data, kind: Kind
        let firstImage: CGImage?, pages: Int
        var sha256: String { HandoffFiles.hash(data) }
        var metadata: [String:Any] { ["opened":true,"path":relativePath,"kind":kind.rawValue,"bytes":data.count,"sha256":sha256,"snapshot":"current"] }
    }
    private static func fail(_ message: String) -> Error { CodingTemporary.fail(message) }
    private static func valid(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 4096 && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }
    private static func directoryIdentity(_ value: stat) -> [String] {
        [String(value.st_dev),String(value.st_ino),String(value.st_mode),String(value.st_uid),String(value.st_gid),HandoffFiles.time(value.st_birthtimespec)]
    }
    static func capture(project: String, path: String) throws -> Snapshot {
        guard valid(project),project.hasPrefix("/"),project != "/",valid(path) else {throw fail("Choose a file inside the selected task’s project.")}
        try CodingTemporary.canonical(project)
        let relative = path.hasPrefix(project+"/") ? String(path.dropFirst(project.count+1)) : path
        let parts=relative.split(separator:"/",omittingEmptySubsequences:false).map(String.init)
        guard !relative.hasPrefix("/"),!relative.contains(":"),parts.count <= 64,parts.allSatisfy({!$0.isEmpty && $0 != "." && $0 != ".."}) else {throw fail("Only unambiguous paths inside this project can be previewed.")}
        let ancestors=project.split(separator:"/").map(String.init)+parts.dropLast()
        guard ancestors.count <= 128 else {throw fail("This file path exceeds the supported depth.")}
        // Reuse native descriptor/open/version primitives; keep the short walk here
        // because a single absolute O_NOFOLLOW open would follow ancestor links.
        var fds=[Int32](), names=[String](), identities=[[String]]()
        defer {for fd in fds.reversed() {close(fd)}}
        let root=try CodingTemporary.checked(open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),"Open filesystem root")
        fds.append(root);names.append("/");identities.append(directoryIdentity(try CodingTemporary.info(root)))
        for name in ancestors {
            let before=try CodingTemporary.namedInfo(fds.last!,name)
            guard before.st_mode & S_IFMT == S_IFDIR else {throw fail("File ancestors must be real directories; links are not followed.")}
            let child=try CodingTemporary.directory(fds.last!,name)
            fds.append(child);names.append(name);identities.append(directoryIdentity(before))
            guard directoryIdentity(try CodingTemporary.info(child)) == directoryIdentity(before) else {throw fail("A file ancestor changed while opening.")}
        }
        func verifyAncestors() throws {
            for i in fds.indices {
                let named=try CodingTemporary.namedInfo(i == 0 ? fds[0]:fds[i-1],names[i])
                guard directoryIdentity(named)==identities[i],directoryIdentity(try CodingTemporary.info(fds[i]))==identities[i] else {throw fail("The project or a file ancestor changed. Open the preview again.")}
            }
        }
        try verifyAncestors()
        let parent=fds.last!,name=parts.last!,before=try CodingTemporary.namedInfo(parent,name)
        guard before.st_mode & S_IFMT == S_IFREG,before.st_nlink == 1 else {throw fail("Only regular files without symbolic or hard links can be previewed.")}
        let ext=(name as NSString).pathExtension.lowercased()
        let kind:Kind = ["png","jpg","jpeg"].contains(ext) ? .image : ext == "pdf" ? .pdf : ["md","markdown"].contains(ext) ? .markdown : .text
        let limit=(kind == .text || kind == .markdown) ? 512*1024:16*1024*1024
        guard before.st_size >= 0,before.st_size <= limit else {throw fail("Preview limit: 512 KiB for text and 16 MiB for images or PDF. The file is unchanged.")}
        let file=try HandoffFiles.opened(parent,name,before);defer {close(file)}
        let size=Int(before.st_size),version=HandoffFiles.version(before)
        var data=Data(),buffer=[UInt8](repeating:0,count:32768);data.reserveCapacity(size)
        while data.count < size {
            let count=Darwin.read(file,&buffer,min(buffer.count,size-data.count))
            if count < 0 && errno == EINTR {continue}
            guard count > 0 else {throw fail("The file changed or could not be read completely.")}
            data.append(contentsOf:buffer.prefix(count))
        }
        guard HandoffFiles.version(try CodingTemporary.info(file))==version,HandoffFiles.version(try CodingTemporary.namedInfo(parent,name))==version else {throw fail("The file changed during reading. Open the preview again.")}
        try verifyAncestors()
        var image:CGImage?,pages=0
        switch kind {
        case .text,.markdown:
            guard let text=String(data:data,encoding:.utf8),!text.contains("\0") else {throw fail("This file is not supported UTF-8 text. Preview supports text, Markdown, PNG, JPEG and PDF.")}
        case .image:
            guard let source=CGImageSourceCreateWithData(data as CFData,[kCGImageSourceShouldCache:false] as CFDictionary),
                  let type=CGImageSourceGetType(source),[UTType.png.identifier,UTType.jpeg.identifier].contains(type as String),
                  let props=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],
                  let width=props[kCGImagePropertyPixelWidth] as? Int,let height=props[kCGImagePropertyPixelHeight] as? Int,
                  width > 0,height > 0,width <= 32768,height <= 32768,width*height <= 64_000_000 else {throw fail("Image is invalid or exceeds the 64 megapixel preview limit.")}
            image=CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceThumbnailMaxPixelSize:2048,kCGImageSourceCreateThumbnailWithTransform:true] as CFDictionary)
            guard image != nil else {throw fail("This image could not be decoded.")}
        case .pdf:
            guard let document=PDFDocument(data:data),!document.isLocked,document.pageCount > 0,document.pageCount <= 1000 else {throw fail("PDF must be readable, unlocked, and contain between 1 and 1,000 pages.")}
            pages=document.pageCount;image=try pdfPage(data,index:0)
        }
        return Snapshot(project:project,relativePath:relative,data:data,kind:kind,firstImage:image,pages:pages)
    }
    static func pdfGeometry(_ bounds:CGRect) throws -> (CGFloat,Int,Int) {
        guard bounds.minX.isFinite,bounds.minY.isFinite,bounds.width.isFinite,bounds.height.isFinite,bounds.width > 0,bounds.height > 0 else {throw fail("This PDF page has invalid dimensions.")}
        let scale=2048/max(bounds.width,bounds.height),width=bounds.width*scale,height=bounds.height*scale
        guard scale.isFinite,scale > 0,width.isFinite,height.isFinite,width > 0,height > 0,
              (bounds.minX*scale).isFinite,(bounds.minY*scale).isFinite else {throw fail("This PDF page cannot be rendered within preview limits.")}
        return (scale,max(1,Int(min(2048,width))),max(1,Int(min(2048,height))))
    }
    static func pdfPage(_ data:Data,index:Int) throws -> CGImage {
        guard let document=PDFDocument(data:data),!document.isLocked,index >= 0,index < document.pageCount,let page=document.page(at:index) else {throw fail("This PDF page is unavailable.")}
        let bounds=page.bounds(for:.mediaBox),geometry=try pdfGeometry(bounds)
        let (scale,width,height)=geometry
        guard let context=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw fail("This PDF page could not be rendered.")}
        context.setFillColor(CGColor(gray:1,alpha:1));context.fill(CGRect(x:0,y:0,width:width,height:height))
        context.scaleBy(x:scale,y:scale);context.translateBy(x:-bounds.minX,y:-bounds.minY)
        // Drawing a page into pixels exposes no PDF links, forms or embedded actions.
        page.draw(with:.mediaBox,to:context)
        guard let image=context.makeImage() else {throw fail("This PDF page could not be rendered.")};return image
    }
}

@MainActor final class CodingFilePreviewSession {
    private var generation=UUID(),panel:CodingFilePreviewPanel?
    var token:UUID {generation}
    func invalidate() {generation=UUID();panel?.close();panel=nil}
    func begin() -> UUID {invalidate();return generation}
    private func require(_ expected:UUID) throws {
        guard expected==generation,!Task.isCancelled else {throw CodingTemporary.fail("The preview was closed, stopped or belongs to another task.")}
    }
    func inspect(_ input:[String:Any],expected:UUID,read:(String) async throws -> [String:Any]) async throws -> CodingFilePreview.Snapshot {
        guard Set(input.keys)==["action","threadId","path"],input["action"] as? String=="open" else {throw CodingTemporary.fail("Invalid file preview request.")}
        let id=try CodingTemporary.string(input,"threadId",limit:200),path=try CodingTemporary.string(input,"path")
        func context() async throws -> [String] {
            try require(expected);let result=try await read(id);try require(expected)
            guard let thread=result["thread"] as? [String:Any],thread["id"] as? String==id else {throw CodingTemporary.fail("The selected task could not be verified.")}
            return [id,try CodingTemporary.string(thread,"cwd"),thread["modelProvider"] as? String ?? ""]
        }
        let before=try await context(),project=before[1]
        let snapshot=try await Task.detached(priority:.userInitiated) {try CodingFilePreview.capture(project:project,path:path)}.value
        try require(expected)
        guard try await context()==before else {throw CodingTemporary.fail("The task project changed during reading. Open the preview again.")}
        try require(expected);return snapshot
    }
    func present(_ snapshot:CodingFilePreview.Snapshot,expected:UUID,owner:NSWindow) throws {
        try require(expected)
        let view=CodingFilePreviewPanel(snapshot:snapshot)
        view.onClose={ [weak self] in guard let self,self.generation==expected else {return};self.generation=UUID();self.panel=nil }
        panel=view;owner.addChildWindow(view.window!,ordered:.above);view.showWindow(nil);view.window?.makeKeyAndOrderFront(nil)
    }
}

@MainActor private final class CodingFilePreviewPanel:NSWindowController,NSWindowDelegate {
    var onClose:(()->Void)?
    private let snapshot:CodingFilePreview.Snapshot,scroll=NSScrollView(),status=NSTextField(labelWithString:""),imageView=NSImageView()
    private var page=0,pageGeneration=UUID(),previous:NSButton!,next:NSButton!
    init(snapshot:CodingFilePreview.Snapshot) {
        self.snapshot=snapshot
        let panel=NSPanel(contentRect:NSRect(x:0,y:0,width:760,height:640),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        super.init(window:panel);panel.delegate=self;panel.title=(snapshot.relativePath as NSString).lastPathComponent+" — Current file snapshot"
        panel.minSize=NSSize(width:480,height:360);panel.isReleasedWhenClosed=false;panel.center()
        let content=NSView(),stack=NSStackView();panel.contentView=content;stack.orientation = .vertical;stack.alignment = .leading;stack.spacing=10
        stack.translatesAutoresizingMaskIntoConstraints=false;content.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:content.leadingAnchor,constant:16),stack.trailingAnchor.constraint(equalTo:content.trailingAnchor,constant:-16),stack.topAnchor.constraint(equalTo:content.topAnchor,constant:16),stack.bottomAnchor.constraint(equalTo:content.bottomAnchor,constant:-16)])
        let title=NSTextField(wrappingLabelWithString:snapshot.relativePath);title.font = .systemFont(ofSize:14,weight:.semibold);title.isSelectable=true;stack.addArrangedSubview(title)
        let caption=NSTextField(labelWithString:"Current file snapshot · Read-only · \(ByteCountFormatter.string(fromByteCount:Int64(snapshot.data.count),countStyle:.file))")
        caption.textColor = .secondaryLabelColor;caption.font = .systemFont(ofSize:12);stack.addArrangedSubview(caption)
        scroll.hasVerticalScroller=true;scroll.hasHorizontalScroller=true;scroll.borderType = .bezelBorder
        stack.addArrangedSubview(scroll);scroll.widthAnchor.constraint(equalTo:stack.widthAnchor).isActive=true
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant:180).isActive=true
        let bar=NSStackView();bar.spacing=8;bar.orientation = .horizontal
        if snapshot.kind == .text || snapshot.kind == .markdown {
            let text=NSTextView(frame:NSRect(x:0,y:0,width:700,height:480));text.isEditable=false;text.isSelectable=true;text.isRichText=false;text.textContainerInset=NSSize(width:14,height:14);text.autoresizingMask=[.width];text.isHorizontallyResizable=false;text.textContainer?.widthTracksTextView=true
            text.font = .monospacedSystemFont(ofSize:13,weight:.regular);text.string=String(decoding:snapshot.data,as:UTF8.self)
            if snapshot.kind == .markdown {text.textStorage?.setAttributedString(Self.markdown(text.string))}
            text.setAccessibilityLabel("Read-only file content");scroll.documentView=text;panel.initialFirstResponder=text
        } else {
            scroll.allowsMagnification=true;scroll.minMagnification=0.5;scroll.maxMagnification=4
            imageView.frame=NSRect(x:0,y:0,width:700,height:480);imageView.imageScaling = .scaleProportionallyUpOrDown;imageView.setAccessibilityLabel(snapshot.kind == .pdf ? "PDF page":"File image")
            scroll.documentView=imageView;setImage(snapshot.firstImage!)
            for (label,selector) in [("Zoom out",#selector(zoomOut)),("Zoom in",#selector(zoomIn))] {bar.addArrangedSubview(NSButton(title:label,target:self,action:selector))}
        }
        if snapshot.kind == .pdf {
            previous=NSButton(title:"Previous page",target:self,action:#selector(previousPage));next=NSButton(title:"Next page",target:self,action:#selector(nextPage))
            previous.keyEquivalent="\u{F702}";next.keyEquivalent="\u{F703}";previous.keyEquivalentModifierMask=[];next.keyEquivalentModifierMask=[]
            bar.addArrangedSubview(previous);bar.addArrangedSubview(status);bar.addArrangedSubview(next);updatePages()
        }
        let close=NSButton(title:"Close",target:self,action:#selector(dismiss));close.keyEquivalent="\u{1b}";close.keyEquivalentModifierMask=[];bar.addArrangedSubview(close);stack.addArrangedSubview(bar)
    }
    required init?(coder:NSCoder) {fatalError("init(coder:) is unsupported")}
    private static func markdown(_ source:String) -> NSAttributedString {
        // Preserve block whitespace and source markers; render inline emphasis/code.
        // Link URLs and attachments never enter the text view's attributed content.
        guard let parsed=try? AttributedString(markdown:source,options:.init(interpretedSyntax:.inlineOnlyPreservingWhitespace)) else {return NSAttributedString(string:source)}
        let result=NSMutableAttributedString()
        for run in parsed.runs {
            let intent=run.inlinePresentationIntent ?? [],font:NSFont = intent.contains(.code) ? .monospacedSystemFont(ofSize:13,weight:.regular):.systemFont(ofSize:14,weight:intent.contains(.stronglyEmphasized) ? .semibold:.regular)
            var attributes:[NSAttributedString.Key:Any]=[.font:font,.foregroundColor:NSColor.labelColor]
            if intent.contains(.emphasized) {attributes[.obliqueness]=0.2}
            if intent.contains(.strikethrough) {attributes[.strikethroughStyle]=NSUnderlineStyle.single.rawValue}
            result.append(NSAttributedString(string:String(parsed[run.range].characters),attributes:attributes))
        }
        return result
    }
    private func setImage(_ image:CGImage) {imageView.image=NSImage(cgImage:image,size:NSSize(width:image.width,height:image.height))}
    private func updatePages() {status.stringValue="Page \(page+1) of \(snapshot.pages)";previous.isEnabled=page>0;next.isEnabled=page+1<snapshot.pages}
    private func turnPage(_ delta:Int) {
        let index=page+delta;guard index >= 0,index < snapshot.pages else {return}
        pageGeneration=UUID();let expected=pageGeneration,data=snapshot.data;previous.isEnabled=false;next.isEnabled=false;status.stringValue="Loading page \(index+1)…"
        Task { [weak self] in
            do {
                let image=try await Task.detached(priority:.userInitiated) {try CodingFilePreview.pdfPage(data,index:index)}.value
                guard let self,self.pageGeneration==expected,self.window?.isVisible==true else {return}
                self.page=index;self.setImage(image);self.updatePages()
            } catch {guard let self,self.pageGeneration==expected else {return};self.updatePages();self.status.stringValue="Page unavailable. Try another page."}
        }
    }
    @objc private func previousPage() {turnPage(-1)}
    @objc private func nextPage() {turnPage(1)}
    @objc private func zoomIn() {scroll.magnification=min(scroll.maxMagnification,scroll.magnification*1.25)}
    @objc private func zoomOut() {scroll.magnification=max(scroll.minMagnification,scroll.magnification/1.25)}
    @objc private func dismiss() {close()}
    func windowWillClose(_ notification:Notification) {pageGeneration=UUID();onClose?()}
}

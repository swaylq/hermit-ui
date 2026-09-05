import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// The `+`'s three doors, and the code that turns whatever comes back through
/// them into `PickedFile`s.
///
/// ## Why three doors and not one
///
/// The web has ONE control: `<input type="file" accept="image/*,.txt,…">`. On an
/// iPhone, Safari answers that control with an action sheet — Photo Library /
/// Take Photo / Choose File — so three doors IS the web's behaviour on this
/// device, not an iOS idiom substituted for it. The wording and the order are
/// Safari's.
///
/// "Take Photo" is offered only where a camera exists, which is also what Safari
/// does; on the simulator the sheet has two rows.
///
/// ## The one conversion
///
/// `/api/upload` accepts png / jpeg / gif / webp and nothing else as an image.
/// An iPhone's camera writes HEIC. Safari converts HEIC to JPEG on its way out
/// of a file input, so a photo picked in the web app arrives as JPEG — and the
/// native picker has to do the same or the same photo would 415. The conversion
/// happens ONLY at the photo-library / camera door, for exactly that reason: a
/// `.heic` chosen out of Files is refused on the web too, and is refused here.
@MainActor
final class AttachPicker: NSObject {
    /// The server's `MAX_BYTES`. Checked here so a file too big to send fails
    /// as a chip instead of as a 200 MB round trip — the sentence is the one the
    /// route would have answered with.
    nonisolated static let maxBytes = 200 * 1024 * 1024

    private weak var host: UIViewController?
    private let onPicked: ([PickedFile]) -> Void
    /// A file the reader chose that we refused before uploading: name and why.
    private let onRefused: (String, String) -> Void
    /// Retains itself while a picker is on screen — UIKit holds only a weak
    /// delegate, and the caller has no reason to keep this object alive.
    private var alive: AttachPicker?

    init(host: UIViewController,
         onPicked: @escaping ([PickedFile]) -> Void,
         onRefused: @escaping (String, String) -> Void) {
        self.host = host
        self.onPicked = onPicked
        self.onRefused = onRefused
        super.init()
    }

    // MARK: - The sheet

    /// Safari's own sheet for a file input, in Safari's own order.
    func present(from source: UIView?) {
        guard let host else { return }
        alive = self
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Photo Library", style: .default) { [weak self] _ in
            self?.presentLibrary()
        })
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            sheet.addAction(UIAlertAction(title: "Take Photo", style: .default) { [weak self] _ in
                self?.presentCamera()
            })
        }
        sheet.addAction(UIAlertAction(title: "Choose File", style: .default) { [weak self] _ in
            self?.presentFiles()
        })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            self?.alive = nil
        })
        // iPad presents an action sheet as a popover and crashes without an
        // anchor. The `+` is the anchor; a nil source falls back to the host's
        // own view so this can never be the thing that terminates the app.
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = source ?? host.view
            pop.sourceRect = (source ?? host.view).bounds
        }
        sheet.view.accessibilityIdentifier = "attach.sheet"
        host.present(sheet, animated: true)
    }

    // MARK: - Photo library

    private func presentLibrary() {
        guard let host else { alive = nil; return }
        var config = PHPickerConfiguration()
        // Unlimited, like `<input multiple>`: the CAPS are the composer's, and
        // going over them is a visible notice rather than a picker that stops
        // you. `admitFiles` writes that sentence.
        config.selectionLimit = 0
        config.filter = .any(of: [.images, .videos])
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        picker.view.accessibilityIdentifier = "attach.library"
        host.present(picker, animated: true)
    }

    // MARK: - Camera

    private func presentCamera() {
        guard let host else { alive = nil; return }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = self
        host.present(picker, animated: true)
    }

    // MARK: - Files

    private func presentFiles() {
        guard let host else { alive = nil; return }
        // The `accept` list, as UTIs. An extension the system cannot name is
        // dropped rather than guessed at — the same blind spot Safari has when
        // it maps an `accept` list, and the server is the boundary either way.
        var types: [UTType] = [.image]
        for ext in AttachCore.safeFileExts {
            if let t = UTType(filenameExtension: ext) { types.append(t) }
        }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = self
        picker.view.accessibilityIdentifier = "attach.files"
        host.present(picker, animated: true)
    }

    // MARK: - Turning what came back into bytes

    /// The four image types `/api/upload` will store as an image, in the order
    /// it is worth asking for them: whatever the asset already is beats a
    /// re-encode.
    nonisolated private static let allowedImageTypes: [(UTType, String, String)] = [
        (.png, "image/png", "png"),
        (.jpeg, "image/jpeg", "jpg"),
        (.gif, "image/gif", "gif"),
        (.webP, "image/webp", "webp"),
    ]

    /// What one pick turned into: bytes, or a sentence saying why not.
    ///
    /// A plain enum rather than `Result<PickedFile, String>` — `String` is not
    /// an `Error`, and inventing an error type for two cases the caller only
    /// ever prints would be ceremony.
    enum Picked {
        case file(PickedFile)
        case refused(String)
    }

    /// One `NSItemProvider` → one `PickedFile`, or a reason.
    ///
    /// Order of attempts:
    ///   1. the asset AS IT IS, if it is already one of the four;
    ///   2. failing that, a JPEG re-encode — which is what Safari hands a file
    ///      input for a HEIC, so it is what the reader already expects;
    ///   3. failing that, the raw file representation, for a video.
    private nonisolated static func pick(from provider: NSItemProvider,
                                         suggested: String) async -> Picked {
        for (type, mime, ext) in allowedImageTypes where provider.hasItemConformingToTypeIdentifier(type.identifier) {
            if let data = await loadData(provider, type.identifier) {
                if data.count > maxBytes { return .refused(tooLarge) }
                let name = renamed(suggested.isEmpty ? "image" : suggested, ext: ext)
                let size = pixelSize(of: data)
                return .file(PickedFile(name: AttachCore.name(name, isImage: true),
                                        mimeType: mime, isImage: true, data: data,
                                        width: size?.0, height: size?.1))
            }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            if let jpeg = await loadJPEG(provider) {
                if jpeg.count > maxBytes { return .refused(tooLarge) }
                let name = renamed(suggested.isEmpty ? "image" : suggested, ext: "jpg")
                let size = pixelSize(of: jpeg)
                return .file(PickedFile(name: AttachCore.name(name, isImage: true),
                                        mimeType: "image/jpeg", isImage: true, data: jpeg,
                                        width: size?.0, height: size?.1))
            }
        }
        // A video, or anything else the library vends. Straight through: the
        // server decides, exactly as it does for the web.
        for id in provider.registeredTypeIdentifiers {
            guard let type = UTType(id), type.conforms(to: .movie) else { continue }
            if let url = await loadFile(provider, id) {
                defer { try? FileManager.default.removeItem(at: url) }
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                if size > maxBytes { return .refused(tooLarge) }
                guard let data = try? Data(contentsOf: url) else { continue }
                let name = suggested.isEmpty ? "video.\(type.preferredFilenameExtension ?? "mov")" : suggested
                return .file(PickedFile(name: AttachCore.name(name, isImage: false),
                                        mimeType: type.preferredMIMEType ?? "application/octet-stream",
                                        isImage: false, data: data, width: nil, height: nil))
            }
        }
        return .refused("could not read that item")
    }

    nonisolated static let tooLarge = "file too large (>\(maxBytes) bytes)"

    /// Keep the reader's filename, swap the extension for the one the bytes
    /// actually are. A HEIC converted to JPEG that kept its `.heic` name would
    /// be stored under an extension that lies about its contents.
    private nonisolated static func renamed(_ name: String, ext: String) -> String {
        let stem = name.contains(".") ? String(name[name.startIndex..<name.lastIndex(of: ".")!]) : name
        return (stem.isEmpty ? "image" : stem) + "." + ext
    }

    /// Pixel dimensions without decoding the whole image — `ImageIO` reads the
    /// header. The web's `readImageDims` costs a full decode in an `<img>`; this
    /// is the same answer for less.
    nonisolated static func pixelSize(of data: Data) -> (Int, Int)? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int,
              let h = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        return (w, h)
    }

    private nonisolated static func loadData(_ provider: NSItemProvider, _ id: String) async -> Data? {
        await withCheckedContinuation { k in
            provider.loadDataRepresentation(forTypeIdentifier: id) { data, _ in k.resume(returning: data) }
        }
    }

    private nonisolated static func loadFile(_ provider: NSItemProvider, _ id: String) async -> URL? {
        await withCheckedContinuation { k in
            provider.loadFileRepresentation(forTypeIdentifier: id) { url, _ in
                // The callback's url is deleted the moment it returns, so the
                // bytes are copied somewhere of our own first.
                guard let url else { return k.resume(returning: nil) }
                let copy = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent)
                try? FileManager.default.copyItem(at: url, to: copy)
                k.resume(returning: FileManager.default.fileExists(atPath: copy.path) ? copy : nil)
            }
        }
    }

    private nonisolated static func loadJPEG(_ provider: NSItemProvider) async -> Data? {
        let image: UIImage? = await withCheckedContinuation { k in
            provider.loadObject(ofClass: UIImage.self) { obj, _ in k.resume(returning: obj as? UIImage) }
        }
        // 0.9, not 1.0: a lossless JPEG of a photo is enormous and the route
        // resizes it to 2000px anyway. Safari's own conversion is in this range.
        return image?.jpegData(compressionQuality: 0.9)
    }

    /// Read one url the document picker handed over. `asCopy: true` means the
    /// file is already ours, in the app's temp directory — no security scope to
    /// open, and nothing to hand back.
    private nonisolated static func read(_ url: URL) -> Picked {
        let name = url.lastPathComponent
        let type = UTType(filenameExtension: url.pathExtension)
        let isImage = type?.conforms(to: .image) ?? false
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if size > maxBytes { return .refused(tooLarge) }
        guard let data = try? Data(contentsOf: url) else { return .refused("could not read \(name)") }
        let dims = isImage ? pixelSize(of: data) : nil
        return .file(PickedFile(name: AttachCore.name(name, isImage: isImage),
                                mimeType: type?.preferredMIMEType ?? "application/octet-stream",
                                isImage: isImage, data: data,
                                width: dims?.0, height: dims?.1))
    }

    /// Everything the pickers funnel through: read in parallel, report in the
    /// order the reader picked, and hand the refusals over as chips of their own
    /// so a skipped file is never silent.
    private func finish(_ providers: [(NSItemProvider, String)]) {
        // `alive` is released at the END of this, not the start. It is the only
        // strong reference this object has — UIKit holds delegates weakly and
        // the caller keeps nothing — so clearing it before the Task runs
        // deallocates `self` between the picker dismissing and the bytes being
        // read, and the `[weak self]` inside quietly does nothing at all. No
        // crash, no error, no chip: the picker just appeared to have picked
        // nothing. That is exactly what it did on the simulator.
        Task { [weak self] in
            var picked: [PickedFile] = []
            var refused: [(String, String)] = []
            for (provider, suggested) in providers {
                switch await AttachPicker.pick(from: provider, suggested: suggested) {
                case .file(let file): picked.append(file)
                case .refused(let why): refused.append((suggested.isEmpty ? "image" : suggested, why))
                }
            }
            await MainActor.run {
                guard let self else { return }
                for (name, why) in refused { self.onRefused(name, why) }
                if !picked.isEmpty { self.onPicked(picked) }
                self.alive = nil
            }
        }
    }
}

// MARK: - PHPicker

extension AttachPicker: PHPickerViewControllerDelegate {
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard !results.isEmpty else { alive = nil; return }
        finish(results.map { ($0.itemProvider, $0.itemProvider.suggestedName ?? "") })
        // NOT `alive = nil` here — see `finish`.
    }
}

// MARK: - Camera

extension AttachPicker: UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    func imagePickerController(_ picker: UIImagePickerController,
                               didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        defer { alive = nil }
        guard let image = info[.originalImage] as? UIImage,
              let jpeg = image.jpegData(compressionQuality: 0.9) else { return }
        let dims = AttachPicker.pixelSize(of: jpeg)
        onPicked([PickedFile(name: "photo.jpg", mimeType: "image/jpeg", isImage: true,
                             data: jpeg, width: dims?.0, height: dims?.1)])
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        alive = nil
    }
}

// MARK: - Files

extension AttachPicker: UIDocumentPickerDelegate {
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        defer { alive = nil }
        var picked: [PickedFile] = []
        for url in urls {
            defer { try? FileManager.default.removeItem(at: url) }
            switch AttachPicker.read(url) {
            case .file(let file): picked.append(file)
            case .refused(let why): onRefused(url.lastPathComponent, why)
            }
        }
        if !picked.isEmpty { onPicked(picked) }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        alive = nil
    }
}

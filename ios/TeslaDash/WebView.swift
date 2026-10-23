import SwiftUI
import WebKit

/// 共享的加载状态
final class WebModel: ObservableObject {
    @Published var isLoading = false
    @Published var errorMessage: String?
}

/// WKWebView 的 SwiftUI 封装
struct WebView: UIViewRepresentable {
    let url: URL
    let token: UUID            // 变化即重新加载
    @ObservedObject var model: WebModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        // 用默认持久化存储，登录 cookie 可以长期保留
        cfg.websiteDataStore = .default()

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = context.coordinator
        wv.isOpaque = false
        let bg = UIColor(red: 0.043, green: 0.051, blue: 0.063, alpha: 1)
        wv.backgroundColor = bg
        wv.scrollView.backgroundColor = bg
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsLinkPreview = false

        context.coordinator.lastToken = token
        context.coordinator.load(wv, url)
        return wv
    }

    func updateUIView(_ wv: WKWebView, context: Context) {
        guard context.coordinator.lastToken != token else { return }
        context.coordinator.lastToken = token
        context.coordinator.load(wv, url)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let model: WebModel
        var lastToken: UUID?
        init(model: WebModel) { self.model = model }

        func load(_ wv: WKWebView, _ url: URL) {
            DispatchQueue.main.async {
                self.model.isLoading = true
                self.model.errorMessage = nil
            }
            var req = URLRequest(url: url)
            req.timeoutInterval = 25
            wv.load(req)
        }

        func webView(_ wv: WKWebView, didStartProvisionalNavigation n: WKNavigation!) {
            DispatchQueue.main.async {
                self.model.isLoading = true
                self.model.errorMessage = nil
            }
        }

        func webView(_ wv: WKWebView, didFinish n: WKNavigation!) {
            DispatchQueue.main.async {
                self.model.isLoading = false
                self.model.errorMessage = nil
            }
        }

        func webView(_ wv: WKWebView, didFail n: WKNavigation!, withError e: Error) { fail(e) }
        func webView(_ wv: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { fail(e) }

        private func fail(_ e: Error) {
            let ns = e as NSError
            // 被取消的加载不算错误
            if ns.code == NSURLErrorCancelled { return }
            DispatchQueue.main.async {
                self.model.isLoading = false
                self.model.errorMessage = Self.describe(ns)
            }
        }

        private static func describe(_ e: NSError) -> String {
            switch e.code {
            case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost:
                return "连不上服务器"
            case NSURLErrorTimedOut:
                return "连接超时"
            case NSURLErrorNotConnectedToInternet:
                return "设备没有网络"
            case NSURLErrorNetworkConnectionLost:
                return "网络连接断开"
            default:
                return e.localizedDescription
            }
        }
    }
}

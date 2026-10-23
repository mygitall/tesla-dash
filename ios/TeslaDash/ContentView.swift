import SwiftUI

struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = "http://100.82.236.49:8787"
    @StateObject private var model = WebModel()
    @State private var showSettings = false
    @State private var reloadToken = UUID()

    private let bg = Color(red: 0.043, green: 0.051, blue: 0.063)

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            bg.ignoresSafeArea()

            if let url = URL(string: serverURL) {
                WebView(url: url, token: reloadToken, model: model)
                    .ignoresSafeArea(edges: [.bottom])
                    .opacity(model.errorMessage == nil ? 1 : 0)
            }

            if model.isLoading && model.errorMessage == nil {
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(Color(red: 0.239, green: 0.863, blue: 0.518))
                    .scaleEffect(1.2)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                    .allowsHitTesting(false)
            }

            if let msg = model.errorMessage {
                ErrorView(
                    message: msg,
                    serverURL: serverURL,
                    onRetry: { reloadToken = UUID() },
                    onSettings: { showSettings = true }
                )
            }

            // 右下角设置入口（很淡，不干扰主界面）
            Button { showSettings = true } label: {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white.opacity(0.45))
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(Color.white.opacity(0.06)))
            }
            .padding(.trailing, 12)
            .padding(.bottom, 22)
            .opacity(model.errorMessage == nil ? 1 : 0)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(serverURL: $serverURL) { reloadToken = UUID() }
        }
    }
}

// MARK: - 错误页
private struct ErrorView: View {
    let message: String
    let serverURL: String
    let onRetry: () -> Void
    let onSettings: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 42, weight: .light))
                .foregroundColor(Color(red: 0.96, green: 0.31, blue: 0.31))

            Text(message)
                .font(.system(size: 19, weight: .semibold))
                .foregroundColor(.white)

            Text(serverURL)
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(.white.opacity(0.4))
                .lineLimit(1)
                .truncationMode(.middle)
                .padding(.horizontal, 24)

            VStack(alignment: .leading, spacing: 8) {
                hint("手机上的 Tailscale 是否已连接？")
                hint("Mac 是否还开着、没睡眠？")
                hint("服务器地址是否改过？")
            }
            .padding(.top, 4)

            HStack(spacing: 12) {
                Button(action: onRetry) {
                    Text("重试")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(Color(red: 0.043, green: 0.09, blue: 0.05))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(
                            RoundedRectangle(cornerRadius: 11)
                                .fill(Color(red: 0.239, green: 0.863, blue: 0.518))
                        )
                }
                Button(action: onSettings) {
                    Text("设置")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.white.opacity(0.8))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(
                            RoundedRectangle(cornerRadius: 11)
                                .stroke(Color.white.opacity(0.18), lineWidth: 1)
                        )
                }
            }
            .padding(.horizontal, 32)
            .padding(.top, 8)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.043, green: 0.051, blue: 0.063))
    }

    private func hint(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(Color.white.opacity(0.28)).frame(width: 4, height: 4).padding(.top, 7)
            Text(text).font(.system(size: 13)).foregroundColor(.white.opacity(0.55))
        }
    }
}

import SwiftUI

struct SettingsView: View {
    @Binding var serverURL: String
    let onApply: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    var body: some View {
        NavigationView {
            Form {
                Section {
                    TextField("http://100.82.236.49:8787", text: $draft)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .font(.system(size: 15, design: .monospaced))
                } header: {
                    Text("服务器地址")
                } footer: {
                    Text("手机需要连着 Tailscale 才能访问。\n改完点右上角「保存」。")
                        .font(.system(size: 12))
                }

                Section {
                    Button("恢复默认") {
                        draft = "http://100.82.236.49:8787"
                    }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            serverURL = trimmed
                            onApply()
                        }
                        dismiss()
                    }
                }
            }
            .onAppear { draft = serverURL }
        }
    }
}

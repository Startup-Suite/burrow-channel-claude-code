# Grants the local-Suite screenshot agent ("local-saru-screenshots") a runtime
# token scoped to ATTACHMENT + CANVAS bundles only (no federation, task, plan,
# org_context, skill, messaging, etc). Idempotent — re-running rotates the
# token and leaves the row's other fields alone.
#
# Run from the core repo:
#   cd ~/projects/core/apps/platform   # or any worktree of core
#   MIX_ENV=dev mix run /Users/grelly/projects/claude-code-suite-channel/scripts/grant-saru-screenshot-token.exs
#
# The script prints exactly one line starting with PASTE_TO_SARU=. Paste that
# line back to Saru in #kelly-playspace. The token grants ONLY:
#   - attachment.upload_start / .upload_inline
#   - canvas.create / .patch / .get / .list
# It does NOT grant any task / plan / org / messaging / federation surface.

token = Platform.Agents.AgentRuntime.generate_token()
hash = Platform.Agents.AgentRuntime.hash_token(token)

case Platform.Repo.get_by(Platform.Agents.AgentRuntime, runtime_id: "local-saru-screenshots") do
  nil ->
    Platform.Repo.insert!(%Platform.Agents.AgentRuntime{
      runtime_id: "local-saru-screenshots",
      display_name: "Saru screenshot evidence (local-only)",
      transport: "websocket",
      status: "active",
      trust_level: "participant",
      allowed_bundles: ["attachment", "canvas"],
      auth_token_hash: hash
    })

  existing ->
    existing
    |> Ecto.Changeset.change(
      auth_token_hash: hash,
      allowed_bundles: ["attachment", "canvas"],
      status: "active"
    )
    |> Platform.Repo.update!()
end

IO.puts("PASTE_TO_SARU=#{token}")

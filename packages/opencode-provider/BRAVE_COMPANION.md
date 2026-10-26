# Chat On OpenCode Companion for Brave (manual, separate extension)

This *separate* unpacked extension is generated from the reviewed Chat On
Steroids extension shipped at the same source SHA; it cannot be installed
silently by OpenCode. The script only pins the existing extension's discovery
to the isolated provider's bridge port **8766**, removes automatic content
script injection and the browser-debugger permission, and changes its name.
The existing Chat On Steroids extension remains installed and uses its normal
bridge (typically 8765). No Chat On Steroids process needs to be stopped.

## Build and install on this Windows desktop

1. Run `node packages/opencode-provider/bin/build-brave-companion.mjs` once from
   this checkout. The script refuses to overwrite an existing extension folder.
2. In Brave open `brave://extensions`, enable Developer mode, choose **Load
   unpacked**, and select the folder
   `packages/opencode-provider/dist/brave-chat-on-opencode` within this checkout.
3. Pin **Chat On OpenCode Companion (Brave)** from Brave's Extensions menu.
   Keep the original **Chat On Steroids** extension installed and untouched.
4. Keep the *dedicated* Chat On OpenCode Provider sign-in window waiting with
   Brave selected. A sign-in transfer offer lasts at most 15 minutes; click
   **Open again** in that window if the offer has expired.
5. In **the same Brave profile** that has the new companion installed, open
   `https://chatgpt.com/` and sign in normally. Then open the **new**
   companion's popup. Confirm it shows a connection to the isolated provider
   (port **8766**, not 8765). Only if it shows a valid transfer button and
   the ChatGPT tab is signed in, click **Bring session to Chat On OpenCode**.
   Brave may then ask you to authorize its optional cookie permission; choose
   yourself whether to allow it. No cookie values appear in ChatGPT/the app's
   instructions or any console output. Cancel instead if the target looks wrong.
6. Check for the provider window's **You're signed in** confirmation. **Close
   that dedicated sign-in window** before trying an OpenCode model turn because
   service mode must exclusively own the isolated Chromium profile.

## Limits and safety

This is a **manual, opt-in** transfer using the same reviewed in-browser
interaction provided by the existing extension. The user decides whether to
grant browser cookie access; no tool or build script reads browser credentials.
The bundle's only loopback host permission is
`http://127.0.0.1:8766/*`. It cannot discover or pair with personal CoS on
`8765`; no content scripts are injected into ChatGPT pages by this copy.

Brave requires user approval to load an unpacked extension into the user's
normal browser profile. Do not alter Brave policies or install the extension
through the registry. Loading this extension in a *fresh temporary Brave user
profile* is also possible, but that profile will not have the user's existing
ChatGPT session; they must sign in again there.

Once the sign-in window confirms, choose
`chat-on-opencode/chatgpt-default` directly in OpenCode. The existing
`Connect provider` API key form is from the old compatible-provider
registration; **do not provide an API key**. A successful transfer is not a
verified OpenCode inference or parity with Chat On Steroids. A dedicated
first-answer test must still succeed; the provider may be blocked by its
separate gateway or outbox requirements.

Run `node --test packages/opencode-provider/test/brave-companion.test.mjs`
to validate the packaged-port and manifest boundaries in a disposable folder.

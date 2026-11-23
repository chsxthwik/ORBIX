# Windows native checklist

Manual checks for the Windows integration (`electron/windows-shell.mjs`, `windows-place.mjs`, `windows-input.mjs`,
`web/js/desktop.js`). Run each item on Windows 11 (22H2 or later) and Windows 10 (22H2), and put a screenshot next to it.
Unit tests for the IPC argument checks and placement are in `test/windows-input.test.mjs`.

Status: **not yet verified by hand**. Only the Windows 11 app start (window opens maximized on its saved monitor,
the page draws the title bar) has been smoke-tested.

| # | Check | Win 11 | Win 10 |
|---|-------|--------|--------|
| 1 | Mica: the desktop tint shows behind the sidebar, menu row and toolbar; the conversation stays solid. | ☐ shot | n/a (solid) ☐ shot |
| 2 | Settings → Personalization → Colors → Transparency effects **off**: Mica goes away at once (no restart). On again: it comes back. | ☐ shot | ☐ |
| 3 | Settings → Appearance → Windows → Mica off: solid window. | ☐ | n/a |
| 4 | Hover the maximize button: the Snap Layouts flyout opens. Win + Z also works. | ☐ shot | n/a |
| 5 | Drag the window by the empty menu row and toolbar; double-click maximizes. Buttons in those rows still click. | ☐ | ☐ |
| 6 | Start a long run, switch away: the taskbar button shows a moving (indeterminate) progress bar. | ☐ shot | ☐ shot |
| 7 | A run asks for permission: amber (paused) bar and the amber dot overlay on the taskbar icon; both clear after you answer. | ☐ shot | ☐ shot |
| 8 | Right-click the taskbar icon: jump list has **New conversation** and up to six **Recent projects**. Each opens ORBIX on that (new conversation / project), also when ORBIX was closed. | ☐ shot | ☐ shot |
| 9 | Remove a recent project from the jump list: it stays removed. | ☐ | ☐ |
| 10 | Run finishes while ORBIX is in the background: toast "Agent finished" with **Open**; Open focuses that exact conversation. | ☐ shot | ☐ shot |
| 11 | Permission request while in the background: toast with **Open** and **Approve once**. Approve once answers "Allow once" without opening the window; the run carries on. | ☐ shot | ☐ shot |
| 12 | Answer the request in the app first, then press Approve once on the old toast: it only brings ORBIX forward. | ☐ | ☐ |
| 13 | Toast from the Action Center after ORBIX restarted: brings ORBIX forward, nothing else. | ☐ | ☐ |
| 14 | Settings → Notifications → Send a test: a Windows toast appears. | ☐ | ☐ |
| 15 | Settings → Appearance → Windows → Use the Windows accent colour: buttons and highlights take the Windows accent; changing the accent in Windows updates ORBIX live. A custom accent under Colors still wins. | ☐ shot | ☐ shot |
| 16 | Windows high contrast on (Left Alt + Left Shift + Print Screen): system colours, the title bar buttons use them, no Mica. Off again: back to the theme. | ☐ shot | ☐ shot |
| 17 | Settings → Accessibility → Text size 150%: ORBIX grows to match live; the window buttons stay as tall as the menu row. Appearance → Windows → Follow Windows text size off: back to 100%. | ☐ shot | ☐ shot |
| 18 | Theme System; switch Windows light/dark: ORBIX, Mica and the window buttons follow without restart. Theme Dark or Light: Mica and buttons follow the theme instead. | ☐ shot | ☐ shot |
| 19 | Two monitors: close ORBIX on the second one, reopen: it opens there with the same size (and maximized if it was). Each monitor remembers its own place. | ☐ | ☐ |
| 20 | Monitors with different scaling (100% and 150%): the window keeps its size when it reopens on either. | ☐ | ☐ |
| 21 | Unplug the monitor ORBIX is on: the window moves to the main monitor, fully visible. Close and reopen without it: opens on the main monitor. | ☐ | ☐ |
| 22 | Lower the taskbar or change resolution: the window stays inside the work area. | ☐ | ☐ |

Non-Windows: `windows-shell.mjs` is imported only behind `process.platform === 'win32'` and throws if imported
anywhere else; `orbixDesktop.windows` is `null` off Windows, so the page skips all of the above.

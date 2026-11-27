# Agent Instructions

## macOS control and application windows

Do not launch the Electron application, packaged application, or any other GUI process that may take control of the user's macOS desktop during development or testing unless the user has explicitly approved it in the current conversation.

Prefer non-GUI checks such as type checking, builds, unit tests, static analysis, and genuinely headless browser tests. Running a command in the background or daemon mode does not make a GUI process safe: Electron windows can still appear and steal focus.

If an Electron or other GUI-based test is required, explain that it may open windows or take focus and ask for explicit approval before running it.

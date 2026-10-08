# Mediathek Renamer

Local web app for renaming file bundles. A bundle is a set of files that share
a name and differ only in their extension:
`Episode 1.mp4`, `Episode 1.srt` and `Episode 1.txt` are one bundle.

## Run

    python3 server.py            # opens http://127.0.0.1:8765/
    python3 server.py --port 9000 --no-browser

Needs Python 3.8+ and nothing else.

## Use

1. Type a folder path or click **Browse…**, then click **Open**.
2. Type a new name in a bundle's field. A preview lists the new file names.
   Click **Save** or press Enter. **Save all changes** saves every edited bundle.
   Press Esc or click ↺ to undo an edit.
   Quick buttons under the field: **Paste name _ → ␣** fills in the old name
   with underscores turned into spaces. A season/episode marker found in the
   old name, such as `(E01_S05)`, gets a button that puts `(E01S05)` at the
   beginning of the new name. Season/episode markers always go first, so
   **Paste name** also moves them to the front.

All files in the bundle are renamed and keep their extensions. The rename is
refused, and nothing is touched, if a target file or a bundle with the new
name already exists. If one file fails partway through, the files already
renamed are restored to their old names.

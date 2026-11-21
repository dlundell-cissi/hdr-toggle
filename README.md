# HDR Toggle

A small GNOME Shell extension that switches HDR on and off for your displays with a keyboard shortcut or a Quick Settings button.

It talks to Mutter's `org.gnome.Mutter.DisplayConfig` D-Bus interface, the same one `gdctl` and GNOME Settings use, and switches the monitor's color mode between `default` and `bt2100`.

## Requirements

- GNOME Shell **51** (this is what `metadata.json` declares; other versions are untested)
- A Wayland session with a display that Mutter reports as HDR capable
- `glib-compile-schemas` only if you copy the directory into place manually instead of using `gnome-extensions install`

If none of the target displays reports HDR support, the Quick Settings button stays hidden and the shortcut does nothing.

## Install

From the extension directory's parent:

```sh
gnome-extensions pack hdr-toggle@cissikatt.se --force
gnome-extensions install --force hdr-toggle@cissikatt.se.shell-extension.zip
```

Then log out and back in (required on Wayland after installing or changing an extension) and enable it:

```sh
gnome-extensions enable hdr-toggle@cissikatt.se
```

`gnome-extensions pack` picks up the `schemas/` directory automatically. On GNOME 44 and later the installer compiles the schema itself, so only the `.gschema.xml` source needs to be shipped and the bundle normally contains no `gschemas.compiled`. You can check what ended up in the bundle with:

```sh
unzip -l hdr-toggle@cissikatt.se.shell-extension.zip
```

To install manually instead, copy the directory to `~/.local/share/gnome-shell/extensions/hdr-toggle@cissikatt.se/` and run `glib-compile-schemas schemas/` inside it.

## Usage

- **Quick Settings:** click the **HDR** toggle.
- **Keyboard shortcut:** `Super+Alt+H` by default, configurable in the extension's preferences.

The toggle reflects the real state of the displays and updates when the monitor configuration changes from elsewhere (GNOME Settings, `gdctl`, hotplug).

## Settings

Open them with `gnome-extensions prefs hdr-toggle@cissikatt.se` or from the Extensions app.

| Setting | Description |
| --- | --- |
| Target Displays | **All** toggles every HDR capable display. **Primary** only toggles the primary display. |
| Remember HDR State | Off (default): the change is temporary and may be reset on restart or when the monitor layout changes. On: Mutter saves the configuration and restores it when the same layout appears again. |
| Keyboard Shortcut | Click the row and press a combination. It must include a modifier other than Shift. Escape cancels, Backspace disables the shortcut. |

If the targeted displays are in a mixed state (some HDR on, some off), toggling turns HDR **off** on all of them.

## How it works

1. Reads the current state with `GetCurrentState`.
2. Builds a new configuration that is identical to the current one except for `color-mode` on the target monitors.
3. Applies it with `ApplyMonitorsConfig` (method 1 = temporary, or 2 = persistent if enabled).

Per-monitor properties are carried over so that toggling HDR does not reset other settings: underscanning is passed back as `enable_underscanning`, and `rgb-range` is passed back unchanged if Mutter reports it. If Mutter rejects the configuration because of such an extra property, the extension retries once without it and logs a warning.

## Known limitations

- Mutter reconfigures the display when the color mode changes, so screens may blink black for a moment. This is Mutter's behavior, not something the extension controls.
- The meaning of the numeric color mode values (`0` = default, `1` = bt2100) comes from observed Mutter behavior and the `gdctl` documentation, not from a specification verified against GNOME 51.
- Other per-monitor settings that newer Mutter versions may add (for example luminance preferences) are not preserved when toggling.
- Only tested on the author's own setup. Reports from other hardware are welcome.

## Troubleshooting

Watch the Shell's log while toggling:

```sh
journalctl -f -o cat /usr/bin/gnome-shell
```

Messages are prefixed with `HDR Toggle:`.

- *Button missing:* no target display reports HDR support. Check with `gdctl show --modes --properties` (it should list a `bt2100` color mode for the monitor). HDR may also need to be supported and enabled by your GPU driver.
- *"apply failed with extra properties, retrying without them":* Mutter did not accept a property that was passed back. Harmless, but worth reporting together with your Mutter version.
- *"failed to apply display config":* the display configuration was rejected; the full D-Bus error follows in the log.

## Files

| File | Purpose |
| --- | --- |
| `extension.js` | Quick toggle, keybinding and the D-Bus logic |
| `prefs.js` | Preferences window |
| `schemas/org.gnome.shell.extensions.hdr-toggle.gschema.xml` | GSettings schema |
| `metadata.json` | Extension metadata |

## License

GPL-2.0-or-later. See [LICENSE](LICENSE) for the GNU General Public License, version 2, and note that "or later" means you may also choose any later version of the GPL. This matches GNOME Shell's own license, which extensions are generally considered derived works of.

Each source file carries an `SPDX-License-Identifier: GPL-2.0-or-later` line.

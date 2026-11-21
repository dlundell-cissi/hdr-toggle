// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Lundell

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { QuickToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';

const DisplayConfigIface = `
<node>
  <interface name="org.gnome.Mutter.DisplayConfig">
    <method name="GetCurrentState">
      <arg name="serial" direction="out" type="u"/>
      <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})"/>
      <arg name="logical_monitors" direction="out" type="a(iiduba(ssss)a{sv})"/>
      <arg name="properties" direction="out" type="a{sv}"/>
    </method>
    <method name="ApplyMonitorsConfig">
      <arg name="serial" direction="in" type="u"/>
      <arg name="method" direction="in" type="u"/>
      <arg name="logical_monitors" direction="in" type="a(iiduba(ssa{sv}))"/>
      <arg name="properties" direction="in" type="a{sv}"/>
    </method>
    <signal name="MonitorsChanged"/>
  </interface>
</node>`;

const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigIface);

// Color modes as used by Mutter ("default" and "bt2100" in gdctl terms).
const COLOR_MODE_DEFAULT = 0;
const COLOR_MODE_BT2100 = 1;

// ApplyMonitorsConfig methods (0 = verify, 1 = temporary, 2 = persistent).
const APPLY_TEMPORARY = 1;
const APPLY_PERSISTENT = 2;

function unpackProp(props, key, fallback) {
	const value = props?.[key];
	return value ? value.deep_unpack() : fallback;
}

const HdrQuickToggle = GObject.registerClass(
	class HdrQuickToggle extends QuickToggle {
		_init(extension) {
			super._init({
				title: 'HDR',
				iconName: 'video-display-symbolic',
				toggleMode: true,
			});

			this.connect('clicked', () => extension.toggleHdr());
		}
	});

const HdrIndicator = GObject.registerClass(
	class HdrIndicator extends SystemIndicator {
		_init(extension) {
			super._init();
			this.toggle = new HdrQuickToggle(extension);
			// Hidden until we know that at least one target display supports HDR.
			this.toggle.visible = false;
			this.quickSettingsItems.push(this.toggle);
		}
	});

export default class HdrToggleExtension extends Extension {
	enable() {
		this._enabled = true;
		this._gen = (this._gen ?? 0) + 1;
		this._applyingConfig = false;
		this._proxyReady = false;
		this._monitorsChangedId = null;
		this._targetChangedId = null;

		this._settings = this.getSettings();
		this._indicator = new HdrIndicator(this);
		Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

		const gen = this._gen;
		this._proxy = new DisplayConfigProxy(
			Gio.DBus.session,
			'org.gnome.Mutter.DisplayConfig',
			'/org/gnome/Mutter/DisplayConfig',
			(proxy, error) => {
				if (gen !== this._gen)
					return;

				if (error) {
					console.error('HDR Toggle: D-Bus proxy error', error);
					return;
				}

				this._proxyReady = true;
				this._monitorsChangedId = proxy.connect('g-signal', (_proxy, _sender, signalName) => {
					if (gen === this._gen && signalName === 'MonitorsChanged')
						this._syncState();
				});
				this._syncState();
			}
		);

		this._targetChangedId = this._settings.connect('changed::target-displays', () => {
			if (this._enabled)
				this._syncState();
		});

		Main.wm.addKeybinding(
			'toggle-hdr-shortcut',
			this._settings,
			Meta.KeyBindingFlags.NONE,
			Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
			() => this.toggleHdr()
		);
	}

	disable() {
		this._enabled = false;
		this._gen++;               // invalidates every pending D-Bus callback
		this._applyingConfig = false;
		this._proxyReady = false;

		Main.wm.removeKeybinding('toggle-hdr-shortcut');

		if (this._proxy && this._monitorsChangedId) {
			this._proxy.disconnect(this._monitorsChangedId);
			this._monitorsChangedId = null;
		}
		this._proxy = null;

		if (this._settings && this._targetChangedId) {
			this._settings.disconnect(this._targetChangedId);
			this._targetChangedId = null;
		}

		if (this._indicator) {
			this._indicator.quickSettingsItems.forEach(item => item.destroy());
			this._indicator.destroy();
			this._indicator = null;
		}

		this._settings = null;
	}

	_ready() {
		return this._enabled && this._proxyReady && this._proxy && this._settings;
	}

	_getPrimaryConnectors(logicalMonitors) {
		const primaryConnectors = new Set();
		for (const [, , , , primary, linkedMonitors] of logicalMonitors) {
			if (primary) {
				for (const [connector] of linkedMonitors)
					primaryConnectors.add(connector);
			}
		}
		return primaryConnectors;
	}

	// Turns the raw GetCurrentState reply into something easier to work with.
	_readState(result) {
		const [serial, monitors, logicalMonitors, layoutProps] = result;
		const primaryOnly = this._settings.get_string('target-displays') === 'primary';
		const primaryConnectors = this._getPrimaryConnectors(logicalMonitors);
		const monitorInfo = new Map();

		for (const [spec, modes, props] of monitors) {
			const connector = spec[0];
			const supported = Array.from(unpackProp(props, 'supported-color-modes', []));

			let modeId = null;
			for (const [id, , , , , , modeProps] of modes) {
				if (unpackProp(modeProps, 'is-current', false)) {
					modeId = id;
					break;
				}
			}

			monitorInfo.set(connector, {
				modeId,
				supportsHdr: supported.includes(COLOR_MODE_BT2100),
				colorMode: unpackProp(props, 'color-mode', COLOR_MODE_DEFAULT),
				isTarget: !primaryOnly || primaryConnectors.has(connector),
				// Read as "is-underscanning", written as "enable_underscanning".
				underscanning: unpackProp(props, 'is-underscanning', null),
				// Kept as the raw variant and passed straight back (see _buildConfig).
				rgbRange: props['rgb-range'] ?? null,
			});
		}

		return { serial, logicalMonitors, layoutProps, monitorInfo };
	}

	_syncState() {
		if (!this._ready())
			return;

		const gen = this._gen;
		this._proxy.GetCurrentStateRemote((result, error) => {
			if (gen !== this._gen || error || !result)
				return;

			const { monitorInfo } = this._readState(result);
			let anyHdrActive = false;
			let hdrSupported = false;

			for (const info of monitorInfo.values()) {
				if (!info.isTarget)
					continue;
				if (info.colorMode === COLOR_MODE_BT2100)
					anyHdrActive = true;
				if (info.supportsHdr)
					hdrSupported = true;
			}

			if (this._indicator?.toggle) {
				this._indicator.toggle.checked = anyHdrActive;
				this._indicator.toggle.visible = hdrSupported;
			}
		});
	}

	// Builds the logical monitor list for ApplyMonitorsConfig.
	// Returns null if a monitor has no current mode.
	// withExtras = also pass back properties we only know by name from
	// gdctl/other extensions (rgb-range), so that toggling HDR does not
	// reset them. The caller retries without them if Mutter rejects it.
	_buildConfig(state, targetColorMode, withExtras) {
		let usedExtras = false;

		const logicalMonitors = state.logicalMonitors.map(
			([x, y, scale, transform, primary, linkedMonitors]) => {
				const configured = [];
				for (const [connector] of linkedMonitors) {
					const info = state.monitorInfo.get(connector);
					if (!info || !info.modeId)
						return null;

					const props = {};

					// Documented writable property; only valid if underscanning is supported.
					if (info.underscanning !== null)
						props['enable_underscanning'] = new GLib.Variant('b', info.underscanning);

					if (withExtras && info.rgbRange) {
						props['rgb-range'] = info.rgbRange;
						usedExtras = true;
					}

					const change = info.isTarget && info.supportsHdr;
					props['color-mode'] = new GLib.Variant('u', change ? targetColorMode : info.colorMode);

					configured.push([connector, info.modeId, props]);
				}
				return [x, y, scale, transform, primary, configured];
			}
		);

		if (logicalMonitors.some(m => m === null))
			return null;

		const applyProps = {};
		// layout-mode may only be passed when changing it is supported.
		if (unpackProp(state.layoutProps, 'supports-changing-layout-mode', false) &&
			state.layoutProps['layout-mode'])
			applyProps['layout-mode'] = state.layoutProps['layout-mode'];

		return { logicalMonitors, applyProps, usedExtras };
	}

	toggleHdr() {
		if (!this._ready())
			return;

		// The quick toggle flips itself on click; always bring it back in sync.
		if (this._applyingConfig) {
			this._syncState();
			return;
		}

		this._applyingConfig = true;
		const gen = this._gen;

		this._proxy.GetCurrentStateRemote((result, error) => {
			if (gen !== this._gen)
				return;

			const finish = () => {
				this._applyingConfig = false;
				this._syncState();
			};

			if (error || !result) {
				console.error('HDR Toggle: failed to read display state', error);
				finish();
				return;
			}

			const state = this._readState(result);
			const targets = [...state.monitorInfo.values()].filter(m => m.isTarget && m.supportsHdr);

			if (targets.length === 0) {
				finish();
				return;
			}

			const currentlyHdr = targets.some(m => m.colorMode === COLOR_MODE_BT2100);
			const targetColorMode = currentlyHdr ? COLOR_MODE_DEFAULT : COLOR_MODE_BT2100;
			const method = this._settings.get_boolean('persistent-apply')
				? APPLY_PERSISTENT
				: APPLY_TEMPORARY;

			const attempt = withExtras => {
				const built = this._buildConfig(state, targetColorMode, withExtras);
				if (!built) {
					console.warn('HDR Toggle: a monitor has no current mode, aborting');
					finish();
					return;
				}

				this._proxy.ApplyMonitorsConfigRemote(
					state.serial,
					method,
					built.logicalMonitors,
					built.applyProps,
					(_res, applyError) => {
						if (gen !== this._gen)
							return;

						if (applyError) {
							if (withExtras && built.usedExtras) {
								console.warn('HDR Toggle: apply failed with extra properties, retrying without them', applyError);
								attempt(false);
								return;
							}
							console.error('HDR Toggle: failed to apply display config', applyError);
							finish();
							return;
						}

						finish();
					}
				);
			};

			attempt(true);
		});
	}
}

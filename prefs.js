// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Lundell

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class HdrTogglePreferences extends ExtensionPreferences {
	fillPreferencesWindow(window) {
		const settings = this.getSettings();

		const page = new Adw.PreferencesPage({
			title: 'General',
			icon_name: 'video-display-symbolic',
		});
		window.add(page);

		// Display behavior group
		const displayGroup = new Adw.PreferencesGroup({
			title: 'Display Behavior',
			description: 'Choose which displays are affected when toggling HDR',
		});
		page.add(displayGroup);

		const targetModel = new Gtk.StringList();
		targetModel.append('All');
		targetModel.append('Primary');

		const targetRow = new Adw.ComboRow({
			title: 'Target Displays',
			subtitle: 'Select whether HDR toggles across all screens or only the primary screen',
			model: targetModel,
		});

		targetRow.selected = settings.get_string('target-displays') === 'primary' ? 1 : 0;

		targetRow.connect('notify::selected', () => {
			const value = targetRow.selected === 1 ? 'primary' : 'all';
			settings.set_string('target-displays', value);
		});

		displayGroup.add(targetRow);

		const persistentRow = new Adw.SwitchRow({
			title: 'Remember HDR State',
			subtitle: 'Let GNOME restore the HDR state when the same monitor layout appears again. Off means the change is temporary.',
		});
		settings.bind('persistent-apply', persistentRow, 'active', Gio.SettingsBindFlags.DEFAULT);
		displayGroup.add(persistentRow);

		// Shortcut group
		const shortcutGroup = new Adw.PreferencesGroup({
			title: 'Keyboard Shortcut',
			description: 'Configure the shortcut used to toggle HDR on or off',
		});
		page.add(shortcutGroup);

		const row = new Adw.ActionRow({
			title: 'Toggle HDR',
			subtitle: 'Click to set a new key combination',
			activatable: true,
		});

		const shortcutLabel = new Gtk.ShortcutLabel({
			disabled_text: 'Disabled',
			valign: Gtk.Align.CENTER,
		});

		const updateLabel = () => {
			const shortcuts = settings.get_strv('toggle-hdr-shortcut');
			shortcutLabel.accelerator = shortcuts.length > 0 ? shortcuts[0] : '';
		};

		updateLabel();
		const changedId = settings.connect('changed::toggle-hdr-shortcut', updateLabel);
		window.connect('close-request', () => {
			settings.disconnect(changedId);
			return Gdk.EVENT_PROPAGATE;
		});

		row.add_suffix(shortcutLabel);
		row.connect('activated', () => this._openShortcutDialog(window, settings));

		shortcutGroup.add(row);
	}

	_openShortcutDialog(parentWindow, settings) {
		const dialog = new Adw.Window({
			title: 'Set Shortcut',
			modal: true,
			transient_for: parentWindow,
			default_width: 360,
			default_height: 240,
			resizable: false,
		});

		const box = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 12,
			margin_top: 24,
			margin_bottom: 24,
			margin_start: 24,
			margin_end: 24,
			valign: Gtk.Align.CENTER,
		});

		const titleLabel = new Gtk.Label({
			label: 'Press your desired shortcut',
			css_classes: ['title-3'],
		});

		const hintLabel = new Gtk.Label({
			label: 'Use at least one modifier (Super, Ctrl or Alt).\nPress Escape to cancel or Backspace to disable.',
			css_classes: ['dim-label'],
			justify: Gtk.Justification.CENTER,
		});

		box.append(titleLabel);
		box.append(hintLabel);

		// A header bar gives the dialog a close button.
		const toolbarView = new Adw.ToolbarView();
		toolbarView.add_top_bar(new Adw.HeaderBar());
		toolbarView.set_content(box);
		dialog.set_content(toolbarView);

		const controller = new Gtk.EventControllerKey();
		controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
		controller.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
			const mask = state & Gtk.accelerator_get_default_mod_mask();
			// With Shift held GTK reports the upper-case keyval; store the lower-case one.
			const key = Gdk.keyval_to_lower(keyval);

			if (mask === 0 && key === Gdk.KEY_Escape) {
				dialog.close();
				return Gdk.EVENT_STOP;
			}

			if (mask === 0 && key === Gdk.KEY_BackSpace) {
				settings.set_strv('toggle-hdr-shortcut', []);
				dialog.close();
				return Gdk.EVENT_STOP;
			}

			// Require a modifier other than Shift, otherwise plain letters
			// would become a global shortcut.
			const hasRealModifier = (mask & ~Gdk.ModifierType.SHIFT_MASK) !== 0;
			if (hasRealModifier && Gtk.accelerator_valid(key, mask)) {
				const accelerator = Gtk.accelerator_name(key, mask);
				settings.set_strv('toggle-hdr-shortcut', [accelerator]);
				dialog.close();
			}

			return Gdk.EVENT_STOP;
		});

		dialog.add_controller(controller);
		dialog.present();
	}
}

/*
    This file is part of Fedora Linux Update Indicator

    Fedora Linux Update Indicator is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Fedora Linux Update Indicator is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with Fedora Linux Update Indicator.  If not, see <http://www.gnu.org/licenses/>.

    Copyright 2023-2024 Ralph Plawetzki
*/

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Button} from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {Extension, gettext as _, ngettext as __} from 'resource:///org/gnome/shell/extensions/extension.js';

/* RegExp to tell what's an update */
/* I am very loose on this, may make it easier to port to other distros */
const RE_UpdateLine = /^(\S+)\.(x86_64|aarch64|i686|noarch)\s+(\S+)$/;

/* Options */
let ALWAYS_VISIBLE     = true;
let USE_BUILDIN_ICONS  = true;
let SHOW_COUNT         = true;
let BOOT_WAIT          = 15;      // 15s
let CHECK_INTERVAL     = 60*60;   // 1h
let NOTIFY             = false;
let HOWMUCH            = 0;
let UPDATE_CMD         = "gnome-terminal -- /bin/sh -c \"sudo dnf upgrade; echo Done - Press enter to exit; read _\" ";
let CHECK_CMD          = "/bin/bash -c \"/usr/bin/dnf check-update --refresh -yq | tail -n +2  | grep -E 'x86_64|i686|noarch|aarch64' | awk '{print $1,$2}'\"";
let MANAGER_CMD        = "";
let PACKAGE_CACHE_DIR  = "";
let STRIP_VERSIONS     = false;
let STRIP_VERSIONS_N   = true;
let AUTO_EXPAND_LIST   = 0;
let DISABLE_PARSING    = false;
let PACKAGE_INFO_CMD   = "xdg-open https://packages.fedoraproject.org/";

/* Variables we want to keep when extension is disabled (eg during screen lock) */
let FIRST_BOOT         = 1;
let UPDATES_PENDING    = -1;
let UPDATES_LIST       = [];

/* A process builder without i10n for reproducible processing. */
var launcher = null;

export default class FedoraUpdateIndicatorExtension extends Extension {

	enable() {
		this.fedoraupdateindicator = new FedoraUpdateIndicator(this);
		Main.panel.addToStatusArea('FedoraUpdateIndicator', this.fedoraupdateindicator);
		this.fedoraupdateindicator._positionChanged();
	}
	disable() {
		this.fedoraupdateindicator.destroy();
		this.fedoraupdateindicator = null;
	}
}

const FedoraUpdateIndicator = GObject.registerClass(
	{
		_TimeoutId: null,
		_FirstTimeoutId: null,
		_FolderChangedTimeoutId: null,
		_updateProcess_sourceId: null,
		_updateProcess_stream: null,
		_updateProcess_pid: null,
		_updateList: [],
	},
class FedoraUpdateIndicator extends Button {

	_init(ext) {
		super._init(0);
		this._extension = ext;

		this.launcher = new Gio.SubprocessLauncher({
			flags: (Gio.SubprocessFlags.STDOUT_PIPE |
							Gio.SubprocessFlags.STDERR_PIPE)
		});
		this.launcher.setenv("LANG", "C", true);

		this.updateIcon = new St.Icon({gicon: this._getCustIcon('fedora-unknown-symbolic'), style_class: 'system-status-icon'});

		let box = new St.BoxLayout({ vertical: false, style_class: 'panel-status-menu-box' });
		this.label = new St.Label({ text: '',
			y_expand: true,
			y_align: Clutter.ActorAlign.CENTER });

		box.add_child(this.updateIcon);
		box.add_child(this.label);
		this.add_child(box);

		// Prepare the special menu : a submenu for updates list that will look like a regular menu item when disabled
		// Scrollability will also be taken care of by the popupmenu
		this.menuExpander = new PopupMenu.PopupSubMenuMenuItem('');

		// Other standard menu items
		let settingsMenuItem = new PopupMenu.PopupMenuItem(_('Settings'));
		this.updateNowMenuItem = new PopupMenu.PopupMenuItem(_('Update now'));
		this.managerMenuItem = new PopupMenu.PopupMenuItem(_('Open package manager'));

		// A special "Checking" menu item with a stop button
		this.checkingMenuItem = new PopupMenu.PopupBaseMenuItem( {reactive:false} );
		let checkingLabel = new St.Label({ text: _('Checking') + " …" });
		let cancelButton = new St.Button({
			child: new St.Icon({ icon_name: 'process-stop-symbolic' }),
			style_class: 'system-menu-action fedora-updates-menubutton',
			x_expand: true
		});
		cancelButton.set_x_align(Clutter.ActorAlign.END);
		this.checkingMenuItem.add_child( checkingLabel );
		this.checkingMenuItem.add_child( cancelButton  );

		// A little trick on "check now" menuitem to keep menu opened
		this.checkNowMenuItem = new PopupMenu.PopupMenuItem( _('Check now') );
		this.checkNowMenuContainer = new PopupMenu.PopupMenuSection();
		this.checkNowMenuContainer.box.add_child(this.checkNowMenuItem.actor);

		// Assemble all menu items into the popup menu
		this.menu.addMenuItem(this.menuExpander);
		this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
		this.menu.addMenuItem(this.updateNowMenuItem);
		this.menu.addMenuItem(this.checkingMenuItem);
		this.menu.addMenuItem(this.checkNowMenuContainer);
		this.menu.addMenuItem(this.managerMenuItem);
		this.menu.addMenuItem(settingsMenuItem);

		// Bind some events
		this.menu.connect('open-state-changed', this._onMenuOpened.bind(this));
		this.checkNowMenuItem.connect('activate', this._checkUpdates.bind(this));
		cancelButton.connect('clicked', this._cancelCheck.bind(this));
		settingsMenuItem.connect('activate', this._openSettings.bind(this));
		this.updateNowMenuItem.connect('activate', this._updateNow.bind(this));
		this.managerMenuItem.connect('activate', this._openManager.bind(this));

		// Some initial status display
		this._showChecking(false);
		this._updateMenuExpander(false, _('Waiting first check'));

		// Restore previous updates list if any
		this._updateList = UPDATES_LIST;

		// Load settings
		this._settings = this._extension.getSettings();
		this._settings.connect('changed', this._positionChanged.bind(this));
		this._settingsChangedId = this._settings.connect('changed', this._applySettings.bind(this));
		this._applySettings();

		if (FIRST_BOOT) {
			// Schedule first check only if this is the first extension load
			// This won't be run again if extension is disabled/enabled (like when screen is locked)
			let that = this;
			this._FirstTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, BOOT_WAIT, function () {
				that._checkUpdates();
				that._FirstTimeoutId = null;
				FIRST_BOOT = 0;
				return false; // Run once
			});
		}

	}

	_getCustIcon(icon_name) {
		if (!USE_BUILDIN_ICONS && St.Settings.get().gtk_icon_theme) {
			let theme = new St.IconTheme();

			if (theme.has_icon(icon_name)) {
				return theme.load_icon(icon_name, 32, St.IconLookupFlags.FORCE_SYMBOLIC);
			}
		}
		// Icon not available in theme, or user prefers built in icon
		return Gio.icon_new_for_string( this._extension.dir.get_child('icons').get_path() + "/" + icon_name + ".svg" );
	}

	_positionChanged(){
		if (this._settings.get_boolean('enable-positioning')) {
			this.container.get_parent().remove_child(this.container);
			let boxes = {
				0: Main.panel._leftBox,
				1: Main.panel._centerBox,
				2: Main.panel._rightBox
			};
			let p = this._settings.get_int('position');
			let i = this._settings.get_int('position-number');
			boxes[p].insert_child_at_index(this.container, i);
		}
	}

	_openSettings() {
		this._extension.openPreferences();
	}

	_openManager() {
		Util.spawnCommandLine(MANAGER_CMD);
	}

	_updateNow() {
		Util.spawnCommandLine(UPDATE_CMD);
	}

	_applySettings() {
		ALWAYS_VISIBLE = this._settings.get_boolean('always-visible');
		USE_BUILDIN_ICONS = this._settings.get_boolean('use-buildin-icons');
		SHOW_COUNT = this._settings.get_boolean('show-count');
		BOOT_WAIT = this._settings.get_int('boot-wait');
		CHECK_INTERVAL = 60 * this._settings.get_int('check-interval');
		NOTIFY = this._settings.get_boolean('notify');
		HOWMUCH = this._settings.get_int('howmuch');
		UPDATE_CMD = this._settings.get_string('update-cmd');
		CHECK_CMD = this._settings.get_string('check-cmd');
		DISABLE_PARSING = this._settings.get_boolean('disable-parsing');
		MANAGER_CMD = this._settings.get_string('package-manager');
		PACKAGE_CACHE_DIR = this._settings.get_string('packages-dir');
		STRIP_VERSIONS = this._settings.get_boolean('strip-versions');
		STRIP_VERSIONS_N = this._settings.get_boolean('strip-versions-in-notification');
		AUTO_EXPAND_LIST = this._settings.get_int('auto-expand-list');
		PACKAGE_INFO_CMD = this._settings.get_string('package-info-cmd');
		this.managerMenuItem.visible = ( MANAGER_CMD != "" );
		this._checkShowHide();
		this._updateStatus();
		this._startFolderMonitor();
		let that = this;
		if (this._TimeoutId) GLib.source_remove(this._TimeoutId);
		this._TimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_INTERVAL, function () {
			that._checkUpdates();
			return true;
		});
	}

	destroy() {
		this._settings.disconnect( this._settingsChangedId );
		if (this._notifSource) {
			// Delete the notification source, which lay still have a notification shown
			this._notifSource.destroy();
			this._notifSource = null;
		};
		if (this.monitor) {
			// Stop spying on package manager local dir
			this.monitor.cancel();
			this.monitor = null;
		}
		if (this._updateProcess_sourceId) {
			// We leave the checkupdate process end by itself but undef handles to avoid zombies
			GLib.source_remove(this._updateProcess_sourceId);
			this._updateProcess_sourceId = null;
			this._updateProcess_stream = null;
		}
		if (this._FirstTimeoutId) {
			GLib.source_remove(this._FirstTimeoutId);
			this._FirstTimeoutId = null;
		}
		if (this._FolderChangedTimeoutId) {
			GLib.source_remove(this._FolderChangedTimeoutId);
			this._FolderChangedTimeoutId = null;
		}
		if (this._TimeoutId) {
			GLib.source_remove(this._TimeoutId);
			this._TimeoutId = null;
		}
		super.destroy();
	}

	_checkShowHide() {
		if ( UPDATES_PENDING == -3 ) {
			// Do not apply visibility change while checking for updates
			return;
		} else if ( UPDATES_PENDING == -2 ) {
			// Always show indicator if there is an error
			this.visible = true;
		} else if (!ALWAYS_VISIBLE && UPDATES_PENDING < 1) {
			this.visible = false;
		} else {
			this.visible = true;
		}
		this.label.visible = SHOW_COUNT && UPDATES_PENDING > 0;
	}

	_onMenuOpened() {
		// This event is fired when menu is shown or hidden
		// Only open the submenu if the menu is being opened and there is something to show
		this._checkAutoExpandList();
	}

	_checkAutoExpandList() {
		if (this.menu.isOpen && UPDATES_PENDING > 0 && UPDATES_PENDING <= AUTO_EXPAND_LIST) {
			this.menuExpander.setSubmenuShown(true);
		} else {
			this.menuExpander.setSubmenuShown(false);
		}
	}

	_startFolderMonitor() {
		if (this.monitoring && this.monitoring != PACKAGE_CACHE_DIR) {
			// The path to be monitored has been changed
			this.monitor.cancel();
			this.monitor = null;
			this.monitoring = null;
		}
		if (PACKAGE_CACHE_DIR && !this.monitoring) {
			// If there's a path to monitor and we're not already monitoring
			this.monitoring = PACKAGE_CACHE_DIR;
			this.packages_dir = Gio.file_new_for_path(PACKAGE_CACHE_DIR);
			this.monitor = this.packages_dir.monitor_directory(0, null);
			this.monitor.connect('changed', this._onFolderChanged.bind(this));
		}
	}

	_onFolderChanged() {
		// Folder have changed ! Let's schedule a check in a few seconds
		let that = this;
		if (this._FolderChangedTimeoutId) GLib.source_remove(this._FolderChangedTimeoutId);
		this._FolderChangedTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, function () {
			that._checkUpdates();
			that._FolderChangedTimeoutId = null;
			return false;
		});
	}

	_showChecking(isChecking) {
		if (isChecking == true) {
			this.updateIcon.set_gicon( this._getCustIcon('fedora-unknown-symbolic') );
			this.checkNowMenuContainer.visible = false;
			this.checkingMenuItem.actor.visible = true;;
		} else {
			this.checkNowMenuContainer.visible = true;;
			this.checkingMenuItem.visible = false;;
		}
	}

	_updateStatus(updatesCount) {
		updatesCount = typeof updatesCount === 'number' ? updatesCount : UPDATES_PENDING;
		if (updatesCount > 0) {
			// Updates pending
			this.updateIcon.set_gicon( this._getCustIcon('fedora-updates-symbolic') );
			this._updateMenuExpander( true, __( "%d update pending", "%d updates pending", updatesCount ).format(updatesCount) );
			this.label.set_text(updatesCount.toString());
			if (NOTIFY && UPDATES_PENDING < updatesCount) {
				if (HOWMUCH > 0) {
					let updateList = [];
					if (HOWMUCH > 1) {
						updateList = this._updateList;
					} else {
						// Keep only packets that was not in the previous notification
						updateList = this._updateList.filter(function(pkg) { return UPDATES_LIST.indexOf(pkg) < 0 });
					}
					// Filter out titles and whatnot
					if (!DISABLE_PARSING) {
						updateList = updateList.filter(function(line) { return RE_UpdateLine.test(line) });
					}
					// If version numbers should be stripped, do it
					if (STRIP_VERSIONS_N == true) {
						updateList = updateList.map(function(p) {
							// Try to keep only what's before the first space
							var chunks = p.split(" ",2);
							return chunks[0];
						});
					}
					if (updateList.length > 0) {
						// Show notification only if there's new updates
						this._showNotification(
							__( "New Fedora Linux Update", "New Fedora Linux Updates", updateList.length ),
							updateList.join(', ')
						);
					}
				} else {
					this._showNotification(
						__( "New Fedora Linux Update", "New Fedora Linux Updates", updatesCount ),
						__( "There is %d update pending", "There are %d updates pending", updatesCount ).format(updatesCount)
					);
				}
			}
			// Store the new list
			UPDATES_LIST = this._updateList;
		} else {
			this.label.set_text('');
			if (updatesCount == -1) {
				// Unknown
				this.updateIcon.set_gicon( this._getCustIcon('fedora-unknown-symbolic') );
				this._updateMenuExpander( false, '' );
			} else if (updatesCount == -2) {
				// Error
				this.updateIcon.set_gicon( this._getCustIcon('fedora-error-symbolic') );
				if ( this.lastUnknowErrorString.indexOf("/usr/bin/checkupdates") > 0 ) {
					this._updateMenuExpander( false, _("Note : you have to install dnf to use the 'check for updates' script.") );
				} else {
					this._updateMenuExpander( false, _('Error') + "\n" + this.lastUnknowErrorString );
				}
			} else {
				// Up to date
				this.updateIcon.set_gicon( this._getCustIcon('fedora-uptodate-symbolic') );
				this._updateMenuExpander( false, _('Up to date :)') );
				UPDATES_LIST = []; // Reset stored list
			}
		}
		UPDATES_PENDING = updatesCount;
		this._checkAutoExpandList();
		this._checkShowHide();
	}

	_updateMenuExpander(enabled, label) {
		this.menuExpander.menu.box.destroy_all_children();
		if (label == "") {
			// No text, hide the menuitem
			this.menuExpander.visible = false;
		} else {
		// We make our expander look like a regular menu label if disabled
			this.menuExpander.reactive = enabled;
			this.menuExpander._triangle.visible = enabled;
			this.menuExpander.label.set_text(label);
			this.menuExpander.visible = true;
			if (enabled && this._updateList.length > 0) {
				this._updateList.forEach( item => {
					if(DISABLE_PARSING) {
						var menutext = item;
						if (STRIP_VERSIONS) {
							var chunks = menutext.split(" ",2);
							menutext = chunks[0];
						}
						this.menuExpander.menu.box.add_child( this._createPackageLabel(menutext) );
					} else {
						let matches = item.match(RE_UpdateLine);
						if (matches == null) {
							// Not an update
							this.menuExpander.menu.box.add_child( new St.Label({ text: item, style_class: 'fedora-updates-update-title' }) );
						} else {
							let hBox = new St.BoxLayout({ vertical: false, style_class: 'fedora-updates-update-line' });
							hBox.add_child( this._createPackageLabel(matches[1]) );
							if (!STRIP_VERSIONS) {
								hBox.add_child( new St.Label({
									text: matches[3],
									style_class: 'fedora-updates-update-version-to' }) );
							}
							this.menuExpander.menu.box.add_child( hBox );
						}
					}
				} );
			}
		}
		// 'Update now' visibility is linked so let's save a few lines and set it here
		this.updateNowMenuItem.reactive = enabled;
		// Seems that's not done anymore by PopupBaseMenuItem after init, so let's update inactive styling
		if ( this.updateNowMenuItem.reactive ) {
			this.updateNowMenuItem.remove_style_class_name('popup-inactive-menu-item');
		} else {
			this.updateNowMenuItem.add_style_class_name('popup-inactive-menu-item');
		}
		if ( this.menuExpander.reactive ) {
			this.menuExpander.remove_style_class_name('popup-inactive-menu-item');
		} else {
			this.menuExpander.add_style_class_name('popup-inactive-menu-item');
		}
	}

	_createPackageLabel(name) {
		if (PACKAGE_INFO_CMD) {
			let label = new St.Label({
				text: name,
				track_hover: true,
				x_expand: true,
				reactive: true,
				style_class: 'fedora-updates-update-name-link'
			});
			let button = new St.Button({
				child: label,
				x_expand: true
			});
			button.connect('clicked', this._packageInfo.bind(this, name));
			return button;
		} else {
			return new St.Label({
				text: name,
				x_expand: true,
				style_class: 'fedora-updates-update-name'
			});
		}
	}

	_packageInfo(item) {
		this.menu.close();
		let proc = this.launcher.spawnv(['dnf', 'info', item]);
		proc.communicate_utf8_async(null, null, (proc, res) => {
			let name = "NAME";
			let rootPackage = "PACKAGE";
			let [,stdout,] = proc.communicate_utf8_finish(res);
			if (proc.get_successful()) {
				let m = stdout.match(/^Name\s+:\s+(\w+(-\w+)*)*.*?^Source\s+:\s+((\w+)(-\w+)?)(-\d)/ms);
				if (m !== null) {
					name = m[1]; // should be same as item
					rootPackage = m[3];
				}
			}
			let command = PACKAGE_INFO_CMD.format(rootPackage, item);
			Util.spawnCommandLine(command);
		});
	}

	_checkUpdates() {
		if(this._updateProcess_sourceId) {
			// A check is already running ! Maybe we should kill it and run another one ?
			return;
		}
		// Run asynchronously, to avoid  shell freeze - even for a 1s check
		this._showChecking(true);
		try {
			// Parse check command line
			let [parseok, argvp] = GLib.shell_parse_argv( CHECK_CMD );
			if (!parseok) { throw 'Parse error' };
			let [res, pid, in_fd, out_fd, err_fd]  = GLib.spawn_async_with_pipes(null, argvp, null, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
			// Let's buffer the command's output - that's a input for us !
			this._updateProcess_stream = new Gio.DataInputStream({
				base_stream: new GioUnix.InputStream({fd: out_fd})
			});
			// We will process the output at once when it's done
			this._updateProcess_sourceId = GLib.child_watch_add(0, pid, () => {this._checkUpdatesRead()} );
			this._updateProcess_pid = pid;
		} catch (err) {
			this._showChecking(false);
			this.lastUnknowErrorString = err.message.toString();
			this._updateStatus(-2);
		}
	}

	_cancelCheck() {
		if (this._updateProcess_pid == null) { return; };
		Util.spawnCommandLine( "kill " + this._updateProcess_pid );
		this._updateProcess_pid = null; // Prevent double kill
		this._checkUpdatesEnd();
	}

	_checkUpdatesRead() {
		// Read the buffered output
		let updateList = [];
		let out, size;
		do {
			[out, size] = this._updateProcess_stream.read_line_utf8(null);
			if (out) updateList.push(out);
		} while (out);
		this._updateList = updateList;
		this._checkUpdatesEnd();
	}

	_checkUpdatesEnd() {
		// Free resources
		this._updateProcess_stream.close(null);
		this._updateProcess_stream = null;
		GLib.source_remove(this._updateProcess_sourceId);
		this._updateProcess_sourceId = null;
		this._updateProcess_pid = null;
		// Update indicator
		this._showChecking(false);
		if (DISABLE_PARSING) {
			this._updateStatus(this._updateList.length);
		} else {
			this._updateStatus(this._updateList.filter(function(line) { return RE_UpdateLine.test(line) }).length);
		}
	}

	_showNotification(title, message) {
		// Destroy previous notification if still there
		if (this._notification) {
			this._notification.destroy(MessageTray.NotificationDestroyedReason.REPLACED);
		}
		// Prepare a notification Source with our name and icon
		// It looks like notification Sources are destroyed when empty so we check every time
		if (this._notifSource == null) {
			// We have to prepare this only once
			this._notifSource = new MessageTray.Source({
				title: this._extension.metadata.name.toString(),
				icon: this._getCustIcon("fedora-lit-symbolic"),
			});
			// Take care of not leaving unneeded sources
			this._notifSource.connect('destroy', ()=>{this._notifSource = null;});
			Main.messageTray.add(this._notifSource);
		}
		// Creates a new notification
		this._notification = new MessageTray.Notification({
			source: this._notifSource,
			title: title,
			body: message
		});
		this._notification.gicon = this._getCustIcon("fedora-updates-symbolic");
		this._notification.addAction( _('Update now') , ()=>{this._updateNow();} );
		this._notification.connect('destroy', ()=>{this._notification = null;});
		this._notifSource.addNotification(this._notification);
	}

});

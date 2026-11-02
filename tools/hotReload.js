// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SOURCE_DIR = Gio.File.new_for_path('@SOURCE_DIR@');
const RELOAD_DELAY = 300;

const listModules = directory => {
    const names = [];
    const children = directory.enumerate_children(
        'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    for (const info of children) {
        const name = info.get_name();
        if (info.get_file_type() === Gio.FileType.REGULAR && name.endsWith('.js'))
            names.push(name);
    }
    children.close(null);
    return names;
};

const importFreshDock = async uuid => {
    const source = SOURCE_DIR.get_child('lib');
    const root = Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_runtime_dir(),
        'glidedock-hot-reload',
        `${GLib.get_monotonic_time()}`,
    ]));
    const directories = ['gnome-shell', 'extensions', uuid, 'lib'].reduce(
        (parents, name) => [parents[0].get_child(name), ...parents], [root]);
    const [copy] = directories;
    copy.make_directory_with_parents(null);

    try {
        for (const name of listModules(source))
            source.get_child(name).copy(copy.get_child(name), Gio.FileCopyFlags.NONE, null, null);

        return await import(copy.get_child('dock.js').get_uri());
    } finally {
        for (const name of listModules(copy))
            copy.get_child(name).delete(null);
        directories.forEach(directory => directory.delete(null));
    }
};

export default class GlideDockHotReload extends Extension {
    enable() {
        this._enabled = true;
        this._reloadSourceId = 0;
        this._stylesheet = this.dir.get_child('stylesheet.css');
        this._monitors = [SOURCE_DIR, SOURCE_DIR.get_child('lib')].map(directory => {
            const monitor = directory.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            monitor.connect('changed', (_monitor, file) => this._handleSourceChanged(file));
            return monitor;
        });
        this._reload();
    }

    disable() {
        this._enabled = false;
        this._monitors.forEach(monitor => monitor.cancel());
        this._monitors = [];
        if (this._reloadSourceId)
            GLib.source_remove(this._reloadSourceId);
        this._reloadSourceId = 0;
        this._dock?.destroy();
        this._dock = null;
        this._getTheme().unload_stylesheet(this._stylesheet);
    }

    _getTheme() {
        return St.ThemeContext.get_for_stage(global.stage).get_theme();
    }

    _handleSourceChanged(file) {
        if (!/\.(js|css)$/.test(file.get_basename()))
            return;

        if (this._reloadSourceId)
            GLib.source_remove(this._reloadSourceId);

        this._reloadSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELOAD_DELAY, () => {
            this._reloadSourceId = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _reload() {
        try {
            const {Dock} = await importFreshDock(this.uuid);
            if (!this._enabled)
                return;

            this._dock?.destroy();
            this._dock = null;
            this._reloadStylesheet();
            this._dock = new Dock(this.getSettings(), SOURCE_DIR);
            console.log('GlideDock: hot reloaded');
        } catch (e) {
            console.error(`GlideDock: hot reload failed: ${e}\n${e.stack}`);
        }
    }

    _reloadStylesheet() {
        const theme = this._getTheme();
        const stylesheet = SOURCE_DIR.get_child('stylesheet.css');
        theme.unload_stylesheet(this._stylesheet);
        this._stylesheet = stylesheet;
        theme.load_stylesheet(stylesheet);
    }
}

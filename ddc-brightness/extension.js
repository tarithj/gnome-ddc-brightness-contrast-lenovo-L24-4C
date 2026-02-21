/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/* exported init */
const GETTEXT_DOMAIN = 'my-indicator-extension';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const ddcNrs = {
    brightness: "10",
    contrast: "12",
    dcr: "EA",
};

const ddcutil_path = "ddcutil";

function changeSet(display, set, value) {
    GLib.spawn_command_line_async(
        `${ddcutil_path} setvcp ${ddcNrs[set]} ${value} --bus ${display.bus}`
    );
}

let displays = [];

async function getCmdOut(cmd) {
    return new Promise((resolve, reject) => {
        let process = Gio.Subprocess.new(
            cmd,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );

        process.communicate_utf8_async(null, null, (proc, res) => {
            try {
                let [, stdout, stderr] = process.communicate_utf8_finish(res);
                if (proc.get_successful()) resolve(stdout);
                else reject(stderr || stdout);
            } catch (e) {
                reject(e);
            }
        });
    });
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, _("Brightness indicator"));

        this.add_child(
            new St.Icon({
                icon_name: "video-display-symbolic",
                style_class: "system-status-icon",
            })
        );

        const getDisplays = async () => {
            let res;
            try {
                res = await getCmdOut(["ddcutil", "detect", "--brief"]);
            } catch (e) {
                logError(e);
                return;
            }

            const displayArray = res.split("\n\n").slice(0, -1);

            for (let i = 0; i < displayArray.length; i++) {
                const v = displayArray[i];
                let display = {};

                display.ddc = !v.includes("Invalid");
                const arr = v.split("\n");

                display.i = i;
                display.name =
                    arr.find(a => a.includes("Monitor"))
                        ?.split(":")[2]?.trim() ||
                    `monitor ${i + 1}`;

                display.bus = arr
                    .find(a => a.includes("I2C bus"))
                    ?.split("/dev/i2c-")[1]?.trim();

                display.sliderTimeouts = {};
                display.sliders = [];

                await newDisplayObj(display);
                displays.push(display);
            }
        };

        const newDisplayObj = async (display) => {

            const makeSlider = async (set) => {
                let menuItem = new PopupMenu.PopupBaseMenuItem();
                menuItem.setOrnament(PopupMenu.Ornament.HIDDEN);

                let oldValue = await getCmdOut([
                    "ddcutil",
                    "getvcp",
                    "--brief",
                    ddcNrs[set],
                    "--bus",
                    display.bus,
                ]);

                oldValue = Number(oldValue.split(" ")[3]);
                let slider = new Slider(oldValue / 100);
                slider.value = oldValue / 100;

                display.sliders.push(menuItem);

                let waiting = false;

                const limit = async () => {
                    if (waiting) return;
                    waiting = true;

                    await new Promise(r =>
                        (display.sliderTimeouts[set] = setTimeout(() => {
                            delete display.sliderTimeouts[set];
                            r();
                        }, 400))
                    );

                    changeSet(display, set, oldValue);
                    waiting = false;
                };

                slider.connect("notify::value", () => {
                    oldValue = (slider.value * 100).toFixed(0);
                    limit();
                });

                menuItem.add_child(
                    new St.Icon({
                        icon_name:
                            set === "brightness"
                                ? "display-brightness-symbolic"
                                : "night-light-symbolic",
                        style_class: "monitor-icon",
                    })
                );

                menuItem.add_child(slider);
                this.menu.addMenuItem(menuItem);
            };

            /* Monitor label */
            this.menu.addMenuItem(
                new PopupMenu.PopupMenuItem(display.name, {
                    reactive: false,
                })
            );

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            if (display.ddc) {

                /* DCR toggle */
                let dcrToggle = new PopupMenu.PopupSwitchMenuItem("DCR", false);
                this.menu.addMenuItem(dcrToggle);

                dcrToggle.connect("toggled", item => {
                    const enabled = item.state;

                    changeSet(display, "dcr", enabled ? 1 : 0);

                    /* disable sliders if DCR enabled */
                    display.sliders.forEach(sliderItem => {
                        sliderItem.setSensitive(!enabled);
                    });
                });

                await makeSlider("brightness");
                await makeSlider("contrast");
            }
        };

        getDisplays();
    }

    destroy() {
        displays.forEach(d => {
            Object.values(d.sliderTimeouts).forEach(clearTimeout);
        });
        super.destroy();
    }
});

export default class MonitorDDCBrightnessExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this._uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        displays = [];
        this._indicator = null;
    }
}

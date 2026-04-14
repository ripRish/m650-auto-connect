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
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const M650_NAME = 'Logi M650';
const BLUEZ_BUS_NAME = 'org.bluez';
const BLUEZ_MANAGER_PATH = '/';
const BLUEZ_DEVICE_INTERFACE = 'org.bluez.Device1';
const BLUEZ_ADAPTER_INTERFACE = 'org.bluez.Adapter1';
const BLUEZ_AGENT_INTERFACE = 'org.bluez.Agent1';
const AGENT_PATH = '/org/gnome/Shell/M650Agent';

// BlueZ Agent XML interface definition
const AgentXML = `
<node>
  <interface name="org.bluez.Agent1">
    <method name="Release" />
    <method name="RequestPinCode">
      <arg type="o" name="device" direction="in" />
      <arg type="s" name="pincode" direction="out" />
    </method>
    <method name="DisplayPinCode">
      <arg type="o" name="device" direction="in" />
      <arg type="s" name="pincode" direction="in" />
    </method>
    <method name="RequestPasskey">
      <arg type="o" name="device" direction="in" />
      <arg type="u" name="passkey" direction="out" />
    </method>
    <method name="DisplayPasskey">
      <arg type="o" name="device" direction="in" />
      <arg type="u" name="passkey" direction="in" />
      <arg type="q" name="entered" direction="in" />
    </method>
    <method name="RequestConfirmation">
      <arg type="o" name="device" direction="in" />
      <arg type="u" name="passkey" direction="in" />
    </method>
    <method name="RequestAuthorization">
      <arg type="o" name="device" direction="in" />
    </method>
    <method name="AuthorizeService">
      <arg type="o" name="device" direction="in" />
      <arg type="s" name="uuid" direction="in" />
    </method>
    <method name="Cancel" />
  </interface>
</node>
`;

const AgentXMLInfo = Gio.DBusNodeInfo.new_for_xml(AgentXML);

const M650Toggle = GObject.registerClass(
class M650Toggle extends QuickToggle {
    constructor(extension) {
        super({
            title: _('M650 Mouse'),
            iconName: 'input-mouse-symbolic',
            toggleMode: true,
        });
        
        this._extension = extension;
        this._internalUpdate = false;

        this.connect('notify::checked', () => {
            if (this._internalUpdate)
                return;

            if (this.checked)
                this._extension._connectToMouse();
            else
                this._extension._disconnectMouse();
        });
    }
});

const M650Indicator = GObject.registerClass(
class M650Indicator extends SystemIndicator {
    constructor(extension) {
        super();
        console.log('[M650] Creating M650Indicator...');

        this._extension = extension;
        try {
            this._indicator = this._addIndicator();
            this._indicator.iconName = 'input-mouse-symbolic';
            console.log('[M650] Indicator icon added');
        } catch (error) {
            console.error(`[M650] Failed to add indicator icon: ${error.message}`);
            this._indicator = null;
        }

        const toggle = new M650Toggle(extension);
        toggle.bind_property('checked',
            this._indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        this.quickSettingsItems.push(toggle);
        console.log('[M650] Toggle added to quickSettingsItems');
        
        this._toggle = toggle;
    }

    updateStatus(connected) {
        try {
            this._toggle._internalUpdate = true;
            this._toggle.checked = connected;
            this._toggle._internalUpdate = false;
            console.log(`[M650] Status updated: connected=${connected}`);
        } catch (error) {
            console.error(`[M650] Error updating status: ${error.message}`);
        }
    }
});

export default class M650MouseExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._devicePath = null;
        this._adapterPath = null;
        this._agentRegistered = false;
        this._dbusExportId = null;
        this._systemBus = null;
    }

    enable() {
        console.log('[M650] ========== Extension ENABLING ==========');
        console.log('[M650] Extension enabled');
        this._indicator = new M650Indicator(this);
        
        try {
            if (Main.panel.statusArea.quickSettings && 
                Main.panel.statusArea.quickSettings.addExternalIndicator) {
                console.log('[M650] Adding indicator to Quick Settings...');
                Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
                console.log('[M650] Indicator added to Quick Settings');
            } else {
                console.log('[M650] Quick Settings not available, attempting fallback...');
                if (Main.panel.statusArea.system) {
                    console.log('[M650] Adding indicator to panel statusArea');
                    Main.panel.addToStatusArea('m650-indicator', this._indicator, 0, 'right');
                    console.log('[M650] Indicator added to statusArea');
                } else {
                    console.warn('[M650] Could not find suitable place to add indicator');
                }
            }
        } catch (error) {
            console.error(`[M650] Error adding indicator: ${error.message}`);
        }
        
        console.log('[M650] Registering BlueZ Agent for auto-pairing...');
        // Register BlueZ Agent for auto-pairing
        const agentResult = this._registerAgent();
        if (agentResult) {
            console.log('[M650] Agent registered successfully');
        } else {
            console.log('[M650] Agent registration had issues, continuing anyway');
        }
        
        // Delay initial connection attempt to ensure agent is ready
        console.log('[M650] Scheduling initial connection attempt in 2000ms...');
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            console.log('[M650] Starting initial connection attempt...');
            this._connectToMouse();
            return false; // Don't repeat
        });
        console.log('[M650] ========== Extension ENABLE COMPLETE ==========');
    }

    disable() {
        console.log('[M650] ========== Extension DISABLING ==========');
        console.log('[M650] Extension disabled');
        // Unregister BlueZ Agent
        console.log('[M650] Unregistering BlueZ Agent...');
        this._unregisterAgent();
        
        if (this._indicator) {
            try {
                this._indicator.quickSettingsItems.forEach(item => item.destroy());
            } catch (e) {
                console.log('[M650] Could not destroy quick settings items');
            }
            this._indicator.destroy();
            this._indicator = null;
        }

        this._disconnectMouse();
        console.log('[M650] ========== Extension DISABLE COMPLETE ==========');
    }

    _registerAgent() {
        try {
            this._systemBus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            console.log('[M650] Got system bus');
            
            // Create a simple agent object that responds to all agent methods
            const agentImpl = {
                Release: () => {
                    console.log('[M650] Agent Release called');
                },
                RequestPinCode: (params) => {
                    console.log('[M650] Agent RequestPinCode - returning 0000');
                    return '0000';
                },
                DisplayPinCode: (devicePath, pin) => {
                    console.log(`[M650] Agent DisplayPinCode: ${pin}`);
                },
                RequestPasskey: (devicePath) => {
                    console.log('[M650] Agent RequestPasskey - returning 0');
                    return 0;
                },
                DisplayPasskey: (devicePath, passkey, entered) => {
                    console.log(`[M650] Agent DisplayPasskey: ${passkey}`);
                },
                RequestConfirmation: (devicePath, passkey) => {
                    console.log(`[M650] Agent RequestConfirmation for ${devicePath}`);
                    // Auto-confirm for M650
                    return true;
                },
                RequestAuthorization: (devicePath) => {
                    console.log(`[M650] Agent RequestAuthorization for ${devicePath}`);
                    return true;
                },
                AuthorizeService: (devicePath, uuid) => {
                    console.log(`[M650] Agent AuthorizeService for ${devicePath}: ${uuid}`);
                    return true;
                },
                Cancel: () => {
                    console.log('[M650] Agent Cancel called');
                }
            };
            
            // Export the agent object manually
            const mainLoopConnection = this._systemBus;
            
            this._dbusExportId = mainLoopConnection.register_object(
                AGENT_PATH,
                agentImpl,
                {
                    Release(invocation) {
                        console.log('[M650] Release invoked');
                        invocation.return_value(null);
                    },
                    RequestPinCode(invocation, devicePath) {
                        console.log('[M650] RequestPinCode invoked');
                        invocation.return_value(GLib.Variant.new('s', '0000'));
                    },
                    DisplayPinCode(invocation, devicePath, pin) {
                        console.log('[M650] DisplayPinCode invoked');
                        invocation.return_value(null);
                    },
                    RequestPasskey(invocation, devicePath) {
                        console.log('[M650] RequestPasskey invoked');
                        invocation.return_value(GLib.Variant.new('u', 0));
                    },
                    DisplayPasskey(invocation, devicePath, passkey, entered) {
                        console.log('[M650] DisplayPasskey invoked');
                        invocation.return_value(null);
                    },
                    RequestConfirmation(invocation, devicePath, passkey) {
                        console.log(`[M650] RequestConfirmation invoked for ${devicePath}`);
                        invocation.return_value(null);
                    },
                    RequestAuthorization(invocation, devicePath) {
                        console.log(`[M650] RequestAuthorization invoked for ${devicePath}`);
                        invocation.return_value(null);
                    },
                    AuthorizeService(invocation, devicePath, uuid) {
                        console.log(`[M650] AuthorizeService invoked for ${devicePath}: ${uuid}`);
                        invocation.return_value(null);
                    },
                    Cancel(invocation) {
                        console.log('[M650] Cancel invoked');
                        invocation.return_value(null);
                    }
                }
            );
            
            if (!this._dbusExportId) {
                console.error('[M650] Failed to export agent object');
                return;
            }
            
            console.log('[M650] Agent object exported with ID: ' + this._dbusExportId);
            
            // Now register with BlueZ AgentManager
            console.log('[M650] Registering with BlueZ AgentManager...');
            const agentManager = Gio.DBusProxy.new_sync(
                this._systemBus,
                Gio.DBusProxyFlags.NONE,
                null,
                BLUEZ_BUS_NAME,
                '/org/bluez',
                'org.bluez.AgentManager1',
                null
            );

            try {
                agentManager.call_sync(
                    'RegisterAgent',
                    GLib.Variant.new('(os)', [AGENT_PATH, 'DisplayYesNo']),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null
                );
                console.log('[M650] BlueZ Agent registered at ' + AGENT_PATH);
            } catch (e) {
                console.log('[M650] Agent registration attempt 1 failed, retrying...');
                try {
                    agentManager.call_sync(
                        'RegisterAgent',
                        GLib.Variant.new('(os)', [AGENT_PATH, 'DisplayYesNo']),
                        Gio.DBusCallFlags.NONE,
                        -1,
                        null
                    );
                    console.log('[M650] BlueZ Agent registered at ' + AGENT_PATH);
                } catch (e2) {
                    console.log('[M650] Agent registration failed: ' + e2.message);
                }
            }
            
            this._agentRegistered = true;

            // Set as default agent
            try {
                agentManager.call_sync(
                    'RequestDefaultAgent',
                    GLib.Variant.new('(o)', [AGENT_PATH]),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null
                );
                console.log('[M650] Agent set as default');
            } catch (error) {
                console.log('[M650] Note: Could not set as default agent');
            }
        } catch (error) {
            console.error(`[M650] Failed to register agent: ${error.message}`);
            this._agentRegistered = false;
        }
    }

    _unregisterAgent() {
        if (!this._agentRegistered) {
            console.log('[M650] Agent not registered, skipping unregister');
            return;
        }

        try {
            console.log('[M650] Unregistering agent from BlueZ...');
            const agentManager = Gio.DBusProxy.new_sync(
                this._systemBus,
                Gio.DBusProxyFlags.NONE,
                null,
                BLUEZ_BUS_NAME,
                '/org/bluez',
                'org.bluez.AgentManager1',
                null
            );

            agentManager.call_sync(
                'UnregisterAgent',
                GLib.Variant.new('(o)', [AGENT_PATH]),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            
            console.log('[M650] BlueZ Agent unregistered');
            
            if (this._dbusExportId) {
                console.log('[M650] Unexporting D-Bus object...');
                this._systemBus.unexport_object(this._dbusExportId);
                this._dbusExportId = null;
            }
            
            this._agentRegistered = false;
        } catch (error) {
            console.error(`[M650] Failed to unregister agent: ${error.message}`);
        }
    }

    async _getDeviceInfo(devicePath) {
        try {
            const systemBus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            const deviceProxy = Gio.DBusProxy.new_sync(
                systemBus,
                Gio.DBusProxyFlags.NONE,
                null,
                BLUEZ_BUS_NAME,
                devicePath,
                BLUEZ_DEVICE_INTERFACE,
                null
            );

            const alias = deviceProxy.get_cached_property('Alias');
            const name = deviceProxy.get_cached_property('Name');
            
            return {
                alias: alias ? alias.unpack() : '',
                name: name ? name.unpack() : ''
            };
        } catch (error) {
            console.error(`[M650] Error getting device info: ${error.message}`);
            return {
                alias: '',
                name: ''
            };
        }
    }

    _getManagedObjects() {
        const systemBus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        const bus = Gio.DBusProxy.new_sync(
            systemBus,
            Gio.DBusProxyFlags.NONE,
            null,
            BLUEZ_BUS_NAME,
            BLUEZ_MANAGER_PATH,
            'org.freedesktop.DBus.ObjectManager',
            null
        );
        const result = bus.call_sync(
            'GetManagedObjects',
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );
        const [objects] = result.deepUnpack();
        return objects;
    }

    _getAdapterPath(objects) {
        for (const [path, interfaces] of Object.entries(objects)) {
            if (BLUEZ_ADAPTER_INTERFACE in interfaces)
                return path;
        }
        return null;
    }

    _getDeviceName(props) {
        if (!props)
            return '';

        const alias = props['Alias'] ? props['Alias'].unpack() : '';
        if (alias)
            return alias;

        return props['Name'] ? props['Name'].unpack() : '';
    }

    _isM650Device(props) {
        const name = this._getDeviceName(props);
        return name.includes(M650_NAME);
    }

    _cleanupPairedM650Devices(adapterPath, objects) {
        if (!adapterPath)
            return;

        const systemBus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        const adapterProxy = Gio.DBusProxy.new_sync(
            systemBus,
            Gio.DBusProxyFlags.NONE,
            null,
            BLUEZ_BUS_NAME,
            adapterPath,
            BLUEZ_ADAPTER_INTERFACE,
            null
        );

        for (const [path, interfaces] of Object.entries(objects)) {
            if (!(BLUEZ_DEVICE_INTERFACE in interfaces))
                continue;

            const props = interfaces[BLUEZ_DEVICE_INTERFACE];
            if (!this._isM650Device(props))
                continue;

            const connected = props['Connected'] ? props['Connected'].unpack() : false;
            const paired = props['Paired'] ? props['Paired'].unpack() : false;
            
            // Only remove M650 devices that are EXPLICITLY PAIRED but DISCONNECTED
            // Leave unpaired quick-pair devices alone - they may reconnect
            if (paired && !connected) {
                try {
                    adapterProxy.call_sync(
                        'RemoveDevice',
                        GLib.Variant.new('(o)', [path]),
                        Gio.DBusCallFlags.NONE,
                        -1,
                        null
                    );
                    console.log(`[M650] Removed old paired M650 device ${path}`);
                } catch (error) {
                    console.log(`[M650] Could not remove ${path}: ${error.message}`);
                }
            }
        }
    }

    _findM650Device() {
        try {
            const objects = this._getManagedObjects();
            const devices = [];

            console.log(`[M650] Searching in ${Object.keys(objects).length} managed objects...`);

            for (const [path, interfaces] of Object.entries(objects)) {
                if (!(BLUEZ_DEVICE_INTERFACE in interfaces))
                    continue;

                const props = interfaces[BLUEZ_DEVICE_INTERFACE];
                const alias = props['Alias'] ? props['Alias'].unpack() : '';
                const name = props['Name'] ? props['Name'].unpack() : '';
                const paired = props['Paired'] ? props['Paired'].unpack() : false;
                const connected = props['Connected'] ? props['Connected'].unpack() : false;
                
                const displayName = alias || name || '(unnamed)';
                console.log(`[M650]   - ${displayName} (alias="${alias}" name="${name}" paired=${paired} connected=${connected})`);
                
                if (alias.toLowerCase().includes(M650_NAME.toLowerCase()) || name.toLowerCase().includes(M650_NAME.toLowerCase())) {
                    devices.push({
                        path,
                        alias,
                        name,
                        paired,
                        connected,
                        props
                    });
                    console.log(`[M650]     ✓ MATCH: M650 found!`);
                }
            }

            console.log(`[M650] Result: Found ${devices.length} M650 device(s)`);
            return devices;
        } catch (error) {
            console.error(`[M650] Error finding M650 device: ${error.message}`);
            return [];
        }
    }

    async _connectToMouse() {
        console.log('[M650] >>> _connectToMouse() START');
        try {
            console.log('[M650] Getting managed objects...');
            let objects = this._getManagedObjects();
            console.log('[M650] Found ' + Object.keys(objects).length + ' managed objects');
            
            const adapterPath = this._getAdapterPath(objects);
            this._adapterPath = adapterPath;

            if (!adapterPath) {
                console.error('[M650] No Bluetooth adapter found');
                this._indicator.updateStatus(false);
                console.log('[M650] <<< _connectToMouse() END: No adapter');
                return;
            }
            console.log('[M650] Adapter found: ' + adapterPath);

            console.log('[M650] Removing old paired M650 devices...');
            this._cleanupPairedM650Devices(adapterPath, objects);
            
            // Wait a moment for BlueZ to process the removal and rediscovery
            await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                resolve();
                return false;
            }));
            
            // Re-fetch after cleanup
            objects = this._getManagedObjects();

            console.log('[M650] Searching for M650 quick pair device...');
            const devices = this._findM650Device();
            console.log('[M650] Found ' + devices.length + ' M650 device(s)');
            
            if (!devices.length) {
                console.log('[M650] No M650 device found - skipping connection (quick pair needs device to be visible)');
                this._indicator.updateStatus(false);
                console.log('[M650] <<< _connectToMouse() END: No device found');
                return;
            }

            const device = devices[0];
            this._devicePath = device.path;
            console.log(`[M650] Using device: ${device.alias || device.name} at ${this._devicePath}`);
            
            if (device.connected) {
                console.log('[M650] Device already connected');
                this._indicator.updateStatus(true);
                console.log('[M650] <<< _connectToMouse() END: Already connected');
                return;
            }

            // Connect to quick pair device
            console.log('[M650] Connecting to M650...');
            try {
                await this._directConnect(this._devicePath);
                console.log('[M650] Connection succeeded, waiting for pairing to complete...');
                
                // Wait longer for pairing confirmation/agent callbacks
                await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                    resolve();
                    return false;
                }));
                
                this._indicator.updateStatus(true);
                console.log('[M650] <<< _connectToMouse() END: Connected and ready');
            } catch (error) {
                console.error(`[M650] Connection failed: ${error.message}`);  
                this._indicator.updateStatus(false);
                console.log('[M650] <<< _connectToMouse() END: Connection failed');
            }
        } catch (error) {
            console.error(`[M650] Error during connection: ${error.message}`);
            console.error(`[M650] Stack: ${error.stack}`);
            this._indicator.updateStatus(false);
            console.log('[M650] <<< _connectToMouse() END: Exception');
        }
    }

    async _directConnect(devicePath, retryCount = 0) {
        const systemBus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        const deviceProxy = Gio.DBusProxy.new_sync(
            systemBus,
            Gio.DBusProxyFlags.NONE,
            null,
            BLUEZ_BUS_NAME,
            devicePath,
            BLUEZ_DEVICE_INTERFACE,
            null
        );

        return new Promise((resolve, reject) => {
            deviceProxy.call(
                'Connect',
                null,
                Gio.DBusCallFlags.NONE,
                15000, // 15 second timeout
                null,
                (proxy, result) => {
                    try {
                        proxy.call_finish(result);
                        console.log(`[M650] Connect() D-Bus call succeeded`);
                        resolve();
                    } catch (error) {
                        console.error(`[M650] Connect() D-Bus call failed: ${error.message}`);
                        
                        // Retry with exponential backoff for certain errors
                        if ((error.message.includes('le-connection-abort-by-local') || 
                             error.message.includes('InProgress')) && retryCount < 3) {
                            const delayMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
                            console.log(`[M650] Retrying connection in ${delayMs}ms (attempt ${retryCount + 1}/3)...`);
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                                this._directConnect(devicePath, retryCount + 1)
                                    .then(resolve)
                                    .catch(reject);
                                return false;
                            });
                        } else {
                            reject(error);
                        }
                    }
                }
            );
        });
    }

    async _connectProfile(devicePath, profileUUID, retryCount = 0) {
        const systemBus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        const deviceProxy = Gio.DBusProxy.new_sync(
            systemBus,
            Gio.DBusProxyFlags.NONE,
            null,
            BLUEZ_BUS_NAME,
            devicePath,
            BLUEZ_DEVICE_INTERFACE,
            null
        );

        return new Promise((resolve, reject) => {
            deviceProxy.call(
                'ConnectProfile',
                GLib.Variant.new('(s)', [profileUUID]),
                Gio.DBusCallFlags.NONE,
                15000,
                null,
                (proxy, result) => {
                    try {
                        proxy.call_finish(result);
                        console.log(`[M650] ConnectProfile('${profileUUID}') succeeded`);
                        resolve();
                    } catch (error) {
                        console.error(`[M650] ConnectProfile('${profileUUID}') failed: ${error.message}`);
                        
                        // Retry with exponential backoff if busy
                        if (error.message.includes('InProgress') && retryCount < 2) {
                            const delayMs = Math.pow(2, retryCount) * 1000;
                            console.log(`[M650] Profile connection in progress, retrying in ${delayMs}ms...`);
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                                this._connectProfile(devicePath, profileUUID, retryCount + 1)
                                    .then(resolve)
                                    .catch(reject);
                                return false;
                            });
                        } else if (error.message.includes('AlreadyConnected')) {
                            console.log(`[M650] Profile already connected`);
                            resolve();
                        } else {
                            reject(error);
                        }
                    }
                }
            );
        });
    }

    _disconnectMouse() {
        try {
            if (!this._devicePath) {
                console.log('[M650] No device path stored, nothing to disconnect');
                return;
            }

            console.log(`[M650] Attempting to disconnect ${this._devicePath}`);
            
            this._directDisconnect(this._devicePath)
                .then(() => {
                    console.log('[M650] Disconnected successfully');
                })
                .catch(error => {
                    // Don't fail loudly if device doesn't exist
                    if (error.message && error.message.includes('UnknownObject')) {
                        console.log('[M650] Device already removed (UnknownObject)');
                    } else {
                        console.log(`[M650] Disconnect failed: ${error.message}`);
                    }
                });
        } catch (error) {
            console.log(`[M650] Disconnect error: ${error.message}`);
        } finally {
            this._devicePath = null; // Clear the stale path
            this._indicator.updateStatus(false);
        }
    }

    async _directDisconnect(devicePath) {
        const systemBus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        const deviceProxy = Gio.DBusProxy.new_sync(
            systemBus,
            Gio.DBusProxyFlags.NONE,
            null,
            BLUEZ_BUS_NAME,
            devicePath,
            BLUEZ_DEVICE_INTERFACE,
            null
        );

        return new Promise((resolve, reject) => {
            deviceProxy.call(
                'Disconnect',
                null,
                Gio.DBusCallFlags.NONE,
                15000,
                null,
                (proxy, result) => {
                    try {
                        proxy.call_finish(result);
                        console.log('[M650] Disconnect() D-Bus call succeeded');
                        resolve();
                    } catch (error) {
                        console.error(`[M650] Disconnect() D-Bus call failed: ${error.message}`);
                        reject(error);
                    }
                }
            );
        });
    }
}

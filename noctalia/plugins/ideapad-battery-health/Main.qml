import QtQuick
import Quickshell.Io

// Start the BatteryPreservationService to restore a previously set preservation
// mode when the plugin is loaded. This is needed as FW may reset
// the preservation mode when the device is fully powered off.
Item {
    property var pluginApi: null

    BatteryPreservationService {
        id: service
        pluginApi: parent.pluginApi
    }

    IpcHandler {
        target: "plugin:ideapad-battery-health"
        function togglePanel() { pluginApi?.withCurrentScreen(s => pluginApi.togglePanel(s)) }
        function set(value: string) {
          var numValue = parseInt(value)
          if (numValue != service.desiredPreservation) {
              service.setPreservation(numValue)
          }
        }
    }
}

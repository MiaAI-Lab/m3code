/**
 * Zero-dependency browser SDK served at `/api/m3-plugins/sdk.js`.
 * Sandboxed iframe plugins can include `<script src="/api/m3-plugins/sdk.js"></script>`
 * to subscribe to M3 Core events and send versioned commands back over `postMessage`.
 */
export const M3_PLUGIN_SDK_SOURCE = `(function () {
  var VERSION = 1;
  var listeners = new Map();
  var pending = new Map();
  var nextId = 1;
  var params = new URLSearchParams(window.location.search);
  var pluginId = params.get("m3_plugin_id") || "unknown";

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.version !== VERSION) return;
    if (data.type === "m3:event") {
      var set = listeners.get(data.event);
      if (set) {
        set.forEach(function (fn) {
          try { fn(data.payload, data); } catch (err) { console.error("[M3Plugin]", err); }
        });
      }
      var wildcard = listeners.get("*");
      if (wildcard) {
        wildcard.forEach(function (fn) {
          try { fn(data.payload, data); } catch (err) { console.error("[M3Plugin]", err); }
        });
      }
    } else if (data.type === "m3:response" && pending.has(data.id)) {
      var entry = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error(data.error || "Command failed"));
    }
  });

  function sendCommand(command, payload) {
    return new Promise(function (resolve, reject) {
      var id = "cmd_" + (nextId++);
      pending.set(id, { resolve: resolve, reject: reject });
      window.parent.postMessage(
        {
          version: VERSION,
          type: "m3:command",
          id: id,
          pluginId: pluginId,
          command: command,
          payload: payload || {},
        },
        "*"
      );
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("M3 bridge command timed out: " + command));
        }
      }, 15000);
    });
  }

  window.M3Plugin = {
    version: VERSION,
    pluginId: pluginId,
    on: function (eventName, handler) {
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName).add(handler);
      return function () {
        var set = listeners.get(eventName);
        if (set) set.delete(handler);
      };
    },
    command: sendCommand,
    toast: function (title, description) {
      return sendCommand("toast:show", { title: title, description: description });
    },
    createThread: function (options) {
      return sendCommand("thread:create", options || {});
    },
    injectPrompt: function (text) {
      return sendCommand("prompt:inject", { text: text });
    },
    openFile: function (path) {
      return sendCommand("file:open", { path: path });
    },
    ready: function () {
      return sendCommand("plugin:ready", {});
    },
  };

  sendCommand("plugin:ready", {}).catch(function () {});
})();
`;

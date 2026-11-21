/*
 * The point cloud worker: decodes EPT nodes with laz-perf off the page's thread. viewer/ept.js starts a few of them.
 * Messages in: {type: "init", lazPerf, wasm, decode} (script URLs), then {type: "decode", id, buffer, origin,
 * sixteenBit}. Out: {type: "ready"} or {type: "init-error", message}; {type: "decoded", id, ...decode's result} or
 * {type: "error", id, message}. A decode before "ready" waits for it.
 */
(function () {
    "use strict";
    var ready = null; // a Promise of laz-perf's module, once init starts

    function errorText(e) {
        return e && e.message ? e.message : String(e);
    }

    function init(message) {
        ready = new Promise(function (resolve, reject) {
            importScripts(message.decode, message.lazPerf);
            // createLazPerf comes from laz-perf's script; locateFile points it at the vendored wasm
            self.createLazPerf({locateFile: function () { return message.wasm; }}).then(resolve, reject);
        });
        ready.then(function () {
            self.postMessage({type: "ready"});
        }, function (e) {
            self.postMessage({type: "init-error", message: errorText(e)});
        });
    }

    function decode(message) {
        if (!ready) {
            self.postMessage({type: "error", id: message.id, message: "not initialised"});
            return;
        }
        ready.then(function (lazPerf) {
            var result = self.ExplorerEptDecode.decode(lazPerf, message.buffer, {origin: message.origin,
                sixteenBit: message.sixteenBit});
            self.postMessage({type: "decoded", id: message.id, count: result.count, positions: result.positions,
                colors: result.colors, sixteenBit: result.sixteenBit},
            [result.positions.buffer, result.colors.buffer]);
        }).then(null, function (e) {
            self.postMessage({type: "error", id: message.id, message: errorText(e)});
        });
    }

    self.onmessage = function (event) {
        var message = event.data || {};
        if (message.type === "init") {
            try {
                init(message);
            } catch (e) {
                self.postMessage({type: "init-error", message: errorText(e)});
            }
        } else if (message.type === "decode") {
            decode(message);
        }
    };
})();

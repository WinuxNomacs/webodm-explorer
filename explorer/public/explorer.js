/*
 * The project Explorer page's Share button: shows the page's full link and copies it. The link only works for
 * signed-in users the project is shared with; nothing is stored.
 */
(function () {
    "use strict";

    function copyText(input, done) {
        var text = input.value;
        // The Clipboard API needs a secure context (https or localhost); a WebODM on plain http falls back to the
        // selected text and execCommand.
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallback()); });
        } else {
            done(fallback());
        }

        function fallback() {
            input.focus();
            input.select();
            try {
                return document.execCommand("copy");
            } catch (e) {
                return false;
            }
        }
    }

    function init(root) {
        var shareButton = root.querySelector("[data-explorer-share]");
        var panel = root.querySelector("#explorer-share");
        if (!shareButton || !panel) return;
        var input = panel.querySelector("input");
        var copyButton = panel.querySelector("[data-explorer-copy]");

        // The template renders the path; the full link uses the address the visitor reached WebODM by.
        input.value = window.location.origin + input.value;

        shareButton.addEventListener("click", function () {
            var opening = panel.hidden;
            panel.hidden = !opening;
            shareButton.setAttribute("aria-expanded", opening ? "true" : "false");
            if (opening) input.select();
        });

        copyButton.addEventListener("click", function () {
            var label = copyButton.innerHTML;
            copyText(input, function (ok) {
                if (!ok) return; // the link stays selected for a manual copy
                copyButton.textContent = copyButton.getAttribute("data-copied");
                setTimeout(function () { copyButton.innerHTML = label; }, 1500);
            });
        });
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { init: init };
    } else {
        init(document);
    }
})();

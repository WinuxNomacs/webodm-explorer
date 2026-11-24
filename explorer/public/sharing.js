/*
 * The Sharing Center's logic, without the page: a link's status (active, expiring soon, expired), the filters and
 * their place in the page's address, and what an Edit form asks the server to change. explorer.js draws the page.
 */
(function () {
    "use strict";
    var DAY = 24 * 60 * 60 * 1000;
    // As the project cards' badge (links.EXPIRES_SOON_DAYS)
    var SOON_DAYS = 7;
    var STATUSES = ["active", "soon", "expired", "all"];
    var DEFAULTS = {project: "", access: "", downloads: "", status: "active", q: ""};
    var CHOICES = {access: ["", "anyone", "sign_in"], downloads: ["", "yes", "no"], status: STATUSES};

    // "expired", "soon" (expires within SOON_DAYS) or "active"; now in milliseconds, the clock by default
    function status(link, now) {
        if (!link.expires) return "active";
        var expires = Date.parse(link.expires);
        now = now === undefined ? Date.now() : now;
        if (expires <= now) return "expired";
        return expires <= now + SOON_DAYS * DAY ? "soon" : "active";
    }

    // Whether visitors need a WebODM login: the link's own Require Sign-In, or Explorer Settings for its project
    function asksSignIn(link) {
        return !!link.sign_in || !!(link.project && link.project.sign_in_forced);
    }

    function matches(link, filters, now) {
        var state = status(link, now);
        if (filters.status === "active" && state === "expired") return false;
        if ((filters.status === "soon" || filters.status === "expired") && state !== filters.status) return false;
        if (filters.project && String(link.project.id) !== String(filters.project)) return false;
        if (filters.access === "sign_in" && !asksSignIn(link)) return false;
        if (filters.access === "anyone" && asksSignIn(link)) return false;
        if (filters.downloads === "yes" && !link.downloads) return false;
        if (filters.downloads === "no" && link.downloads) return false;
        var words = (filters.q || "").trim().toLowerCase();
        if (!words) return true;
        var haystack = [link.label || "", link.project.name || "", link.created_by || ""].join("\n").toLowerCase();
        return words.split(/\s+/).every(function (word) { return haystack.indexOf(word) !== -1; });
    }

    function filter(links, filters, now) {
        return links.filter(function (link) { return matches(link, filters, now); });
    }

    // How many links each status filter shows
    function counts(links, now) {
        var result = {active: 0, soon: 0, expired: 0, all: links.length};
        links.forEach(function (link) {
            var state = status(link, now);
            if (state === "expired") {
                result.expired++;
            } else {
                result.active++;
                if (state === "soon") result.soon++;
            }
        });
        return result;
    }

    // The filters from the page's query string; unknown values give the defaults
    function readFilters(search) {
        var filters = {};
        var params = {};
        (search || "").replace(/^\?/, "").split("&").forEach(function (pair) {
            if (!pair) return;
            var at = pair.indexOf("=");
            var name = decodeURIComponent((at === -1 ? pair : pair.slice(0, at)).replace(/\+/g, " "));
            params[name] = at === -1 ? "" : decodeURIComponent(pair.slice(at + 1).replace(/\+/g, " "));
        });
        Object.keys(DEFAULTS).forEach(function (name) {
            var value = params[name];
            var valid = value !== undefined && (CHOICES[name] ? CHOICES[name].indexOf(value) !== -1
                : name === "project" ? /^[0-9]+$/.test(value) : true);
            filters[name] = valid ? value : DEFAULTS[name];
        });
        filters.q = filters.q.slice(0, 100);
        return filters;
    }

    // The query string for the filters, leaving out the defaults ("" when all are)
    function writeFilters(filters) {
        var parts = [];
        Object.keys(DEFAULTS).forEach(function (name) {
            var value = filters[name] || "";
            if (value !== DEFAULTS[name]) parts.push(name + "=" + encodeURIComponent(value));
        });
        return parts.length ? "?" + parts.join("&") : "";
    }

    // What an Edit form changes: the label when it differs, and a new expiry unless "keep" ("") is chosen. null when
    // nothing changes.
    function editChange(link, label, expiry) {
        var change = {};
        var trimmed = (label || "").trim();
        if (trimmed !== (link.label || "")) change.label = trimmed;
        if (expiry !== "") change.expires_days = expiry;
        return Object.keys(change).length ? change : null;
    }

    var Sharing = {status: status, asksSignIn: asksSignIn, matches: matches, filter: filter, counts: counts,
        readFilters: readFilters, writeFilters: writeFilters, editChange: editChange, DEFAULTS: DEFAULTS};
    if (typeof module !== "undefined" && module.exports) {
        module.exports = Sharing;
    } else {
        window.ExplorerSharing = Sharing;
    }
})();

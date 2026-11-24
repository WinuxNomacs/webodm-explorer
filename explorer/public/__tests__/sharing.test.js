const Sharing = require("../sharing.js");
const { init } = require("../explorer.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-24T12:00:00Z");
const PROJECT = {id: 7, name: "Roof Survey", page: "/plugins/explorer/project/7/",
    links_api: "/api/plugins/explorer/projects/7/links/", links_work: true, sign_in_forced: false};
const OTHER = {id: 9, name: "Bridge", page: "/plugins/explorer/project/9/",
    links_api: "/api/plugins/explorer/projects/9/links/", links_work: true, sign_in_forced: true};

function link(token, fields) {
    return Object.assign({token: token.repeat(43), label: "Client", created: "2026-11-20T10:00:00+00:00",
        expires: new Date(NOW + 30 * DAY).toISOString(), path: "/plugins/explorer/s/" + token.repeat(43) + "/",
        downloads: false, sign_in: false, expired: false, project: PROJECT, created_by: "pilot"}, fields);
}

describe("the logic", () => {
    test("a link is active, expiring soon within 7 days, or expired", () => {
        expect(Sharing.status(link("a", {expires: null}), NOW)).toBe("active");
        expect(Sharing.status(link("a"), NOW)).toBe("active");
        expect(Sharing.status(link("a", {expires: new Date(NOW + 6 * DAY).toISOString()}), NOW)).toBe("soon");
        expect(Sharing.status(link("a", {expires: new Date(NOW - 1000).toISOString()}), NOW)).toBe("expired");
    });

    test("the filters pick by status, project, access, downloads and words in the label, project or maker", () => {
        const links = [
            link("a"),
            link("b", {expires: new Date(NOW + 2 * DAY).toISOString(), downloads: true}),
            link("c", {expires: new Date(NOW - DAY).toISOString(), expired: true}),
            link("d", {project: OTHER, label: "Inspector"}),
        ];
        const pick = (changes) => Sharing.filter(links, Object.assign({}, Sharing.DEFAULTS, changes), NOW)
            .map((l) => l.token[0]).join("");
        expect(pick({})).toBe("abd");
        expect(pick({status: "soon"})).toBe("b");
        expect(pick({status: "expired"})).toBe("c");
        expect(pick({status: "all"})).toBe("abcd");
        expect(pick({project: "9"})).toBe("d");
        // Explorer Settings that make every link of a project ask for a login count as Require Sign-In
        expect(pick({access: "sign_in"})).toBe("d");
        expect(pick({access: "anyone"})).toBe("ab");
        expect(pick({downloads: "yes"})).toBe("b");
        expect(pick({downloads: "no"})).toBe("ad");
        expect(pick({q: "bridge insp"})).toBe("d");
        expect(pick({q: "PILOT", status: "all"})).toBe("abcd");
        expect(pick({q: "nobody"})).toBe("");
        expect(Sharing.counts(links, NOW)).toEqual({active: 3, soon: 1, expired: 1, all: 4});
    });

    test("the filters live in the address without their defaults, and unknown values are ignored", () => {
        expect(Sharing.readFilters("")).toEqual(Sharing.DEFAULTS);
        expect(Sharing.readFilters("?project=7&status=all&q=roof+top&access=sign_in&downloads=no")).toEqual(
            {project: "7", status: "all", q: "roof top", access: "sign_in", downloads: "no"});
        expect(Sharing.readFilters("?project=x&status=gone&access=1")).toEqual(Sharing.DEFAULTS);
        expect(Sharing.writeFilters(Sharing.DEFAULTS)).toBe("");
        expect(Sharing.writeFilters(Object.assign({}, Sharing.DEFAULTS, {status: "expired", q: "a&b"})))
            .toBe("?status=expired&q=a%26b");
    });

    test("an edit sends only what changed, and nothing when nothing did", () => {
        const l = link("a");
        expect(Sharing.editChange(l, " Client ", "")).toBeNull();
        expect(Sharing.editChange(l, "New", "")).toEqual({label: "New"});
        expect(Sharing.editChange(l, "Client", "never")).toEqual({expires_days: "never"});
        expect(Sharing.editChange(l, "", "7")).toEqual({label: "", expires_days: "7"});
    });
});

function json(status, body) {
    return Promise.resolve({ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error()) : Promise.resolve(body))});
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const TEXTS = `data-copy="Copy" data-copied="Copied" data-revoke="Revoke" data-confirm-revoke="Revoke?"
    data-untitled="Untitled Link" data-never="Never expires" data-expires="Expires %(date)s" data-expired-on="Expired %(date)s"
    data-downloads="Allow Downloads" data-sign-in="Require Sign-In" data-forced-title="Forced."
    data-embed-sign-in="Asks for a login." data-open="Open" data-open-title="Open it" data-embed="Embed"
    data-embed-page="The Whole Page" data-embed-label="Show" data-edit="Edit" data-save="Save" data-cancel="Cancel"
    data-renew="Renew" data-label="Label" data-expiry="Expiry" data-keep-expiry="Keep the Current Expiry"
    data-expiry-7="7 days" data-expiry-30="30 days" data-expiry-90="90 days" data-expiry-never="Never"
    data-error="Something went wrong."`;

function renderCenter(responses, search) {
    window.fetch = jest.fn(() => responses.shift());
    window.history.replaceState(null, "", "/plugins/explorer/sharing/" + (search || ""));
    document.body.innerHTML = `
        <div class="explorer-sharing" data-all-links-api="/api/plugins/explorer/links/" ${TEXTS}
             data-none="No links yet." data-no-match="No match." data-confirm-delete="Delete?" data-delete="Delete"
             data-by="by %(user)s" data-unknown-user="a removed account" data-expires-soon="Expires Soon"
             data-status-expired="Expired" data-blocked="Blocked." data-column-project="Project">
            <input type="hidden" name="csrfmiddlewaretoken" value="csrf-value">
            <button type="button" data-sharing-create>Create Link</button>
            <form class="explorer-sharing-create" hidden>
                <select name="project"><option value="">Choose</option><option value="7">Roof Survey</option><option value="9">Bridge</option></select>
                <input name="label"><select name="expires_days"><option value="30" selected>30</option></select>
                <label><input type="checkbox" name="downloads"></label><label><input type="checkbox" name="sign_in"></label>
                <button type="submit">Create Link</button>
                <div class="explorer-sharing-create-error" hidden></div>
            </form>
            <form class="explorer-sharing-filters">
                <input type="search" name="q">
                <select name="status"><option value="active">Active</option><option value="soon">Expiring Soon</option><option value="expired">Expired</option><option value="all">All Links</option></select>
                <select name="project"><option value="">All Projects</option><option value="7">Roof Survey</option><option value="9">Bridge</option></select>
                <select name="access"><option value="">Any</option><option value="anyone">Anyone</option><option value="sign_in">Sign-In</option></select>
                <select name="downloads"><option value="">Any</option><option value="yes">Yes</option><option value="no">No</option></select>
            </form>
            <div class="explorer-links-error" hidden></div>
            <table class="explorer-sharing-table" hidden><tbody class="explorer-sharing-rows"></tbody></table>
            <p class="explorer-sharing-empty" hidden></p>
            <script type="application/json" id="explorer-sharing-projects">${JSON.stringify([PROJECT, OTHER])}</script>
            <script type="application/json" id="explorer-embed-views">{"7": [{"task": "Roof", "views": [{"label": "Map", "path": "map/1/"}]}]}</script>
        </div>`;
    init(document);
    return {
        rows: () => [...document.querySelectorAll("tr.explorer-sharing-row")],
        filters: document.querySelector(".explorer-sharing-filters"),
        create: document.querySelector(".explorer-sharing-create"),
        empty: document.querySelector(".explorer-sharing-empty"),
        error: document.querySelector(".explorer-links-error"),
    };
}

const LIVE = link("a");
const EXPIRED = link("c", {label: "Old", expires: new Date(Date.now() - DAY).toISOString(), expired: true});
const FORCED = link("d", {project: OTHER, label: "Inspector"});

afterEach(() => {
    delete window.fetch;
    jest.restoreAllMocks();
});

describe("the Sharing Center", () => {
    test("it lists the active links with their project, maker and actions, and hides expired ones by default", async () => {
        const { rows, filters } = renderCenter([json(200, [LIVE, EXPIRED, FORCED])]);
        await settle();
        expect(window.fetch).toHaveBeenCalledWith("/api/plugins/explorer/links/", expect.objectContaining({method: "GET"}));
        expect(rows().map((r) => r.getAttribute("data-token")[0])).toEqual(["a", "d"]);
        const first = rows()[0];
        expect(first.querySelector("a").getAttribute("href")).toBe("/plugins/explorer/project/7/#share");
        expect(first.textContent).toContain("by pilot");
        expect(first.querySelector(".explorer-link-address").value).toBe(window.location.origin + LIVE.path);
        expect([...first.querySelectorAll("button, a.btn")].map((b) => b.textContent)).toEqual(
            ["Open", "Embed", "Copy", "Edit", "Revoke"]);
        // Require Sign-In fixed on where Explorer Settings ask it of every link of the project
        const forced = rows()[1].querySelector("input[name=sign_in]");
        expect(forced.checked).toBe(true);
        expect(forced.disabled).toBe(true);
        expect([...filters.elements.status.options].map((o) => o.textContent)).toEqual(
            ["Active (2)", "Expiring Soon (0)", "Expired (1)", "All Links (3)"]);
    });

    test("the Expired filter shows expired links with Renew and Delete only, and goes into the address", async () => {
        const { rows, filters } = renderCenter([json(200, [LIVE, EXPIRED])]);
        await settle();
        filters.elements.status.value = "expired";
        filters.dispatchEvent(new Event("change"));
        expect(window.location.search).toBe("?status=expired");
        expect(rows()).toHaveLength(1);
        const row = rows()[0];
        expect(row.className).toContain("explorer-sharing-expired");
        expect([...row.querySelectorAll("button, a.btn")].map((b) => b.textContent)).toEqual(["Renew", "Delete"]);
        expect(row.querySelector("input[name=downloads]").disabled).toBe(true);
        expect(row.textContent).toContain("Expired ");
    });

    test("filters come from the address and the search narrows the rows", async () => {
        const { rows, filters, empty } = renderCenter([json(200, [LIVE, FORCED])], "?project=9");
        await settle();
        expect(filters.elements.project.value).toBe("9");
        expect(rows().map((r) => r.getAttribute("data-token")[0])).toEqual(["d"]);
        filters.elements.q.value = "nothing like it";
        filters.elements.q.dispatchEvent(new Event("input", {bubbles: true}));
        expect(rows()).toHaveLength(0);
        expect(empty.hidden).toBe(false);
        expect(empty.textContent).toBe("No match.");
    });

    test("with no links it says so", async () => {
        const { empty } = renderCenter([json(200, [])]);
        await settle();
        expect(empty.hidden).toBe(false);
        expect(empty.textContent).toBe("No links yet.");
    });

    test("Renew sends a new expiry for the same link and lists it again", async () => {
        const renewed = Object.assign({}, EXPIRED, {expired: false, expires: new Date(Date.now() + 30 * DAY).toISOString()});
        const { rows, filters } = renderCenter([json(200, [EXPIRED]), json(200, renewed), json(200, [renewed])], "?status=all");
        await settle();
        const row = rows()[0];
        row.querySelector("button").click();
        const form = document.querySelector(".explorer-link-edit");
        expect(form.hidden).toBe(false);
        // Renewing needs a new expiry: no "keep", 30 days chosen
        expect(form.elements.expires_days.value).toBe("30");
        expect([...form.elements.expires_days.options].map((o) => o.value)).toEqual(["7", "30", "90", "never"]);
        form.dispatchEvent(new Event("submit", {cancelable: true}));
        await settle();
        await settle();
        expect(window.fetch.mock.calls[1][0]).toBe(PROJECT.links_api + EXPIRED.token + "/");
        expect(window.fetch.mock.calls[1][1].method).toBe("PATCH");
        expect(JSON.parse(window.fetch.mock.calls[1][1].body)).toEqual({expires_days: "30"});
        expect(rows()[0].className).not.toContain("explorer-sharing-expired");
        expect(filters.elements.status.value).toBe("all");
    });

    test("Delete removes an expired link after asking", async () => {
        jest.spyOn(window, "confirm").mockReturnValue(true);
        const { rows } = renderCenter([json(200, [EXPIRED]), json(204), json(200, [])], "?status=expired");
        await settle();
        [...rows()[0].querySelectorAll("button")].find((b) => b.textContent === "Delete").click();
        await settle();
        await settle();
        expect(window.confirm).toHaveBeenCalledWith("Delete?");
        expect(window.fetch.mock.calls[1][1].method).toBe("DELETE");
        expect(rows()).toHaveLength(0);
    });

    test("Create Link makes a link for the chosen project, with Require Sign-In fixed where every link needs it", async () => {
        const made = link("n", {project: OTHER, sign_in: true});
        const { create, rows } = renderCenter([json(200, []), json(201, made), json(200, [made])], "?q=zzz");
        await settle();
        const submit = create.querySelector("[type=submit]");
        expect(submit.disabled).toBe(true);
        document.querySelector("[data-sharing-create]").click();
        expect(create.hidden).toBe(false);
        create.elements.project.value = "9";
        create.elements.project.dispatchEvent(new Event("change"));
        expect(create.elements.sign_in.checked).toBe(true);
        expect(create.elements.sign_in.disabled).toBe(true);
        create.elements.label.value = "Inspector";
        create.dispatchEvent(new Event("submit", {cancelable: true}));
        await settle();
        await settle();
        expect(window.fetch.mock.calls[1][0]).toBe(OTHER.links_api);
        expect(JSON.parse(window.fetch.mock.calls[1][1].body)).toEqual(
            {label: "Inspector", expires_days: "30", downloads: false, sign_in: true});
        // The search would hide the new link: the filters go back to their defaults so it shows
        expect(rows().map((r) => r.getAttribute("data-token")[0])).toEqual(["n"]);
        expect(window.location.search).toBe("");
        expect(document.activeElement).toBe(rows()[0].querySelector(".explorer-link-address"));
    });

    test("a refused change shows the server's reason", async () => {
        const { rows, error } = renderCenter([json(200, [LIVE]), json(400, {label: ["Not a valid label."]})]);
        await settle();
        [...rows()[0].querySelectorAll("button")].find((b) => b.textContent === "Edit").click();
        const form = document.querySelector(".explorer-link-edit");
        form.elements.label.value = "New";
        form.dispatchEvent(new Event("submit", {cancelable: true}));
        await settle();
        await settle();
        expect(error.hidden).toBe(false);
        expect(error.textContent).toBe("Not a valid label.");
    });
});

describe("the Share panel's Edit", () => {
    test("Edit keeps the expiry by default and sends only the new label", async () => {
        window.ExplorerSharing = Sharing;
        const api = "/api/plugins/explorer/projects/7/links/";
        const live = {token: "t".repeat(43), label: "Client", created: "2026-11-21T10:00:00+00:00",
            expires: "2026-12-21T10:00:00+00:00", path: "/plugins/explorer/s/" + "t".repeat(43) + "/", expired: false};
        const responses = [json(200, [live]), json(200, Object.assign({}, live, {label: "Renamed"})),
            json(200, [Object.assign({}, live, {label: "Renamed"})])];
        window.fetch = jest.fn(() => responses.shift());
        document.body.innerHTML = `
            <div class="explorer-links" data-links-api="${api}" ${TEXTS} data-none="No links yet.">
                <div class="explorer-links-list"></div>
                <form class="explorer-link-form"><input type="hidden" name="csrfmiddlewaretoken" value="c">
                    <input name="label"><select name="expires_days"><option value="30">30</option></select>
                    <input type="checkbox" name="downloads"><button type="submit">Create Link</button></form>
                <div class="explorer-links-error" hidden></div>
            </div>`;
        init(document);
        await settle();
        const edit = [...document.querySelectorAll(".explorer-link button")].find((b) => b.textContent === "Edit");
        edit.click();
        const form = document.querySelector(".explorer-link-edit");
        expect(form.elements.expires_days.value).toBe("");
        form.elements.label.value = "Renamed";
        form.dispatchEvent(new Event("submit", {cancelable: true}));
        await settle();
        await settle();
        expect(window.fetch.mock.calls[1][0]).toBe(api + live.token + "/");
        expect(JSON.parse(window.fetch.mock.calls[1][1].body)).toEqual({label: "Renamed"});
        expect(document.querySelector(".explorer-link .explorer-card-title").textContent).toBe("Renamed");
    });
});

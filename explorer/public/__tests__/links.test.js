const { init } = require("../explorer.js");

const API = "/api/plugins/explorer/projects/7/links/";
const LINK = {token: "t".repeat(43), label: "Client", created: "2026-11-21T10:00:00+00:00",
    expires: "2026-12-21T10:00:00+00:00", path: "/plugins/explorer/s/" + "t".repeat(43) + "/"};

function json(status, body) {
    return Promise.resolve({ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error()) : Promise.resolve(body))});
}

// Lets every pending promise callback run
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(responses) {
    window.fetch = jest.fn(() => responses.shift());
    document.body.innerHTML = `
        <div id="explorer-share">
            <input id="explorer-share-link" readonly value="/plugins/explorer/project/7/">
            <button type="button" data-explorer-copy data-copied="Copied">Copy</button>
            <div class="explorer-links" data-links-api="${API}" data-copy="Copy" data-copied="Copied" data-revoke="Revoke"
                 data-confirm-revoke="Revoke?" data-untitled="Untitled Link" data-never="Never expires"
                 data-expires="Expires %(date)s" data-none="No links yet." data-downloads="Allow Downloads"
                 data-error="Something went wrong.">
                <div class="explorer-links-list"></div>
                <form class="explorer-link-form">
                    <input type="hidden" name="csrfmiddlewaretoken" value="csrf-value">
                    <input name="label"><select name="expires_days"><option value="30" selected>30</option><option value="never">never</option></select>
                    <input type="checkbox" name="downloads">
                    <button type="submit">Create Link</button>
                </form>
                <div class="explorer-links-error" hidden></div>
            </div>
        </div>`;
    init(document);
    return {
        list: document.querySelector(".explorer-links-list"),
        form: document.querySelector(".explorer-link-form"),
        error: document.querySelector(".explorer-links-error"),
    };
}

afterEach(() => {
    delete window.fetch;
    jest.restoreAllMocks();
});

test("the panel lists the project's links with their full address and expiry", async () => {
    const { list } = render([json(200, [LINK, {...LINK, token: "u".repeat(43), label: "", expires: null}])]);
    await settle();
    expect(window.fetch).toHaveBeenCalledWith(API, expect.objectContaining({method: "GET", credentials: "same-origin"}));
    const rows = list.querySelectorAll(".explorer-link");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".explorer-link-address").value).toBe(window.location.origin + LINK.path);
    expect(rows[0].textContent).toContain("Client");
    expect(rows[0].textContent).toContain("Expires ");
    expect(rows[1].textContent).toContain("Untitled Link");
    expect(rows[1].textContent).toContain("Never expires");
});

test("a project without links says so", async () => {
    const { list } = render([json(200, [])]);
    await settle();
    expect(list.textContent).toBe("No links yet.");
});

test("creating a link posts the label and expiry with the CSRF token, then selects the new link", async () => {
    const { form, list } = render([json(200, []), json(201, LINK), json(200, [LINK])]);
    await settle();
    form.elements.label.value = "Client";
    form.elements.expires_days.value = "never";
    form.elements.downloads.checked = true;
    form.dispatchEvent(new Event("submit", {cancelable: true}));
    expect(form.querySelector("[type=submit]").disabled).toBe(true);
    await settle();
    const [url, options] = window.fetch.mock.calls[1];
    expect(url).toBe(API);
    expect(options.method).toBe("POST");
    expect(options.headers["X-CSRFToken"]).toBe("csrf-value");
    expect(JSON.parse(options.body)).toEqual({label: "Client", expires_days: "never", downloads: true});
    expect(form.elements.label.value).toBe("");
    expect(form.elements.downloads.checked).toBe(false);
    expect(form.querySelector("[type=submit]").disabled).toBe(false);
    const input = list.querySelector(".explorer-link-address");
    expect(input.selectionEnd).toBe(input.value.length);
});

test("a refused create shows the server's reason and leaves the form usable", async () => {
    const { form, error } = render([json(200, []), json(503, {detail: "Links are being changed elsewhere."})]);
    await settle();
    form.dispatchEvent(new Event("submit", {cancelable: true}));
    await settle();
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Links are being changed elsewhere.");
    expect(form.querySelector("[type=submit]").disabled).toBe(false);
});

test("an answer that is not JSON shows the general message", async () => {
    const { error } = render([json(500)]);
    await settle();
    expect(error.textContent).toBe("Something went wrong.");
});

test("revoking asks first, then deletes the link and lists the rest", async () => {
    const { list } = render([json(200, [LINK]), json(204), json(200, [])]);
    await settle();
    jest.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const revoke = list.querySelector(".btn-danger");
    revoke.click();
    expect(window.fetch).toHaveBeenCalledTimes(1);
    revoke.click();
    await settle();
    const [url, options] = window.fetch.mock.calls[1];
    expect(url).toBe(API + LINK.token + "/");
    expect(options.method).toBe("DELETE");
    expect(options.headers["X-CSRFToken"]).toBe("csrf-value");
    expect(list.textContent).toBe("No links yet.");
});

test("each link shows whether it allows downloads", async () => {
    const { list } = render([json(200, [{...LINK, downloads: true}, {...LINK, token: "u".repeat(43)}])]);
    await settle();
    const boxes = list.querySelectorAll(".explorer-link-downloads input[type=checkbox]");
    expect([...boxes].map((box) => box.checked)).toEqual([true, false]);
    expect(list.querySelector(".explorer-link-downloads").textContent).toContain("Allow Downloads");
});

test("ticking Allow Downloads on a link changes it at once with the CSRF token", async () => {
    const { list } = render([json(200, [LINK]), json(200, {...LINK, downloads: true})]);
    await settle();
    const box = list.querySelector(".explorer-link-downloads input");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(box.disabled).toBe(true);
    await settle();
    const [url, options] = window.fetch.mock.calls[1];
    expect(url).toBe(API + LINK.token + "/");
    expect(options.method).toBe("PATCH");
    expect(options.headers["X-CSRFToken"]).toBe("csrf-value");
    expect(JSON.parse(options.body)).toEqual({downloads: true});
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
});

test("a refused change puts the box back and says why", async () => {
    const { list, error } = render([json(200, [{...LINK, downloads: true}]), json(404, {detail: "Not found."})]);
    await settle();
    const box = list.querySelector(".explorer-link-downloads input");
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Not found.");
});

test("users who cannot change the project get no link list", () => {
    window.fetch = jest.fn();
    document.body.innerHTML = `<div id="explorer-share"><input id="explorer-share-link" value="/x/"><button data-explorer-copy></button></div>`;
    init(document);
    expect(window.fetch).not.toHaveBeenCalled();
});

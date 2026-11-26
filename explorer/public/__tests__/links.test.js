const { init } = require("../explorer.js");

const API = "/api/plugins/explorer/projects/7/links/";
const LINK = {token: "t".repeat(43), label: "Client", created: "2026-11-21T10:00:00+00:00",
    expires: "2026-12-21T10:00:00+00:00", path: "/plugins/explorer/s/" + "t".repeat(43) + "/"};

function json(status, body) {
    return Promise.resolve({ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error()) : Promise.resolve(body))});
}

// Lets every pending promise callback run
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(responses, origin, forced) {
    window.fetch = jest.fn(() => responses.shift());
    document.body.innerHTML = `
        <div id="explorer-share">
            <input id="explorer-share-link" readonly value="/plugins/explorer/project/7/">
            <button type="button" data-explorer-copy data-copied="Copied">Copy</button>
            <div class="explorer-links" data-links-api="${API}"${origin ? ` data-origin="${origin}"` : ""} data-copy="Copy" data-copied="Copied" data-revoke="Revoke"
                 data-confirm-revoke="Revoke?" data-untitled="Untitled Link" data-never="Never expires"
                 data-expires="Expires %(date)s" data-none="No links yet." data-downloads="Allow Downloads" data-photos="Allow Source Photos" data-all-files="Allow All Task Files" data-sign-in="Require Sign-In"
                 ${forced ? 'data-sign-in-forced data-forced-title="Every link asks for a login."' : ""}
                 data-embed-sign-in="Asks for a login.""
                 data-open="Open" data-open-title="Open the link as visitors see it"
                 data-error="Something went wrong.">
                <div class="explorer-links-list"></div>
                <form class="explorer-link-form">
                    <input type="hidden" name="csrfmiddlewaretoken" value="csrf-value">
                    <input name="label"><select name="expires_days"><option value="30" selected>30</option><option value="never">never</option></select>
                    <input type="checkbox" name="downloads">
                    <input type="checkbox" name="photos"><input type="checkbox" name="all_files">
                    <input type="checkbox" name="sign_in"${forced ? " checked disabled" : ""}>
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

test("each link opens in a new tab as visitors see it", async () => {
    const { list } = render([json(200, [LINK])]);
    await settle();
    const open = list.querySelector(".explorer-link a");
    expect(open.textContent).toBe("Open");
    expect(open.getAttribute("href")).toBe(LINK.path);
    expect(open.target).toBe("_blank");
    expect(open.rel).toBe("noopener noreferrer");
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
    form.elements.photos.checked = true;
    form.dispatchEvent(new Event("submit", {cancelable: true}));
    expect(form.querySelector("[type=submit]").disabled).toBe(true);
    await settle();
    const [url, options] = window.fetch.mock.calls[1];
    expect(url).toBe(API);
    expect(options.method).toBe("POST");
    expect(options.headers["X-CSRFToken"]).toBe("csrf-value");
    expect(JSON.parse(options.body)).toEqual({label: "Client", expires_days: "never", downloads: true, photos: true, all_files: false,
        sign_in: false});
    expect(form.elements.label.value).toBe("");
    expect(form.elements.downloads.checked).toBe(false);
    expect(form.elements.photos.checked).toBe(false);
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

test("revoking a link that is already gone lists the links as they are now, and says why", async () => {
    const { list, error } = render([json(200, [LINK]), json(404, {detail: "No such link."}), json(200, [])]);
    await settle();
    jest.spyOn(window, "confirm").mockReturnValue(true);
    list.querySelector(".btn-danger").click();
    await settle(); await settle(); await settle();
    expect(window.fetch).toHaveBeenCalledTimes(3);
    expect(list.textContent).toBe("No links yet.");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("No such link.");
});

test("each link shows whether it allows downloads", async () => {
    const { list } = render([json(200, [{...LINK, downloads: true}, {...LINK, token: "u".repeat(43)}])]);
    await settle();
    const boxes = list.querySelectorAll(".explorer-link-downloads input[name=downloads]");
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

test("ticking Allow Source Photos on a link changes it at once", async () => {
    const { list } = render([json(200, [LINK]), json(200, {...LINK, photos: true})]);
    await settle();
    const box = list.querySelector("input[name=photos]");
    expect(box.parentNode.textContent).toContain("Allow Source Photos");
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(JSON.parse(window.fetch.mock.calls[1][1].body)).toEqual({photos: true});
    expect(box.checked).toBe(true);
});

test("Allow All Task Files on a link is greyed out, keeping its value, while Allow Downloads is off", async () => {
    const { list } = render([json(200, [{...LINK, downloads: false, all_files: true}]),
        json(200, {...LINK, downloads: true, all_files: true}), json(200, {...LINK, downloads: true, all_files: false}),
        json(200, {...LINK, downloads: false, all_files: false})]);
    await settle();
    const all = list.querySelector("input[name=all_files]");
    const downloads = list.querySelector("input[name=downloads]");
    expect(all.parentNode.textContent).toContain("Allow All Task Files");
    expect(all.checked).toBe(true);
    expect(all.disabled).toBe(true);
    downloads.checked = true;
    downloads.dispatchEvent(new Event("change"));
    await settle();
    expect(all.disabled).toBe(false);
    all.checked = false;
    all.dispatchEvent(new Event("change"));
    await settle();
    expect(JSON.parse(window.fetch.mock.calls[2][1].body)).toEqual({all_files: false});
    expect(all.disabled).toBe(false);
    downloads.checked = false;
    downloads.dispatchEvent(new Event("change"));
    await settle();
    expect(all.disabled).toBe(true);
});

test("a refused Allow Downloads change leaves Allow All Task Files as it was", async () => {
    const { list } = render([json(200, [{...LINK, downloads: false}]), json(503, {detail: "Busy."})]);
    await settle();
    const downloads = list.querySelector("input[name=downloads]");
    downloads.checked = true;
    downloads.dispatchEvent(new Event("change"));
    await settle();
    expect(downloads.checked).toBe(false);
    expect(list.querySelector("input[name=all_files]").disabled).toBe(true);
});

test("the create form's Allow All Task Files is usable only with Allow Downloads ticked, and posted", async () => {
    const { form } = render([json(200, []), json(201, LINK), json(200, [LINK])]);
    await settle();
    const all = form.elements.all_files;
    expect(all.disabled).toBe(true);
    form.elements.downloads.checked = true;
    form.elements.downloads.dispatchEvent(new Event("change"));
    expect(all.disabled).toBe(false);
    all.checked = true;
    form.elements.downloads.checked = false;
    form.elements.downloads.dispatchEvent(new Event("change"));
    expect(all.checked).toBe(false);
    expect(all.disabled).toBe(true);
    form.elements.downloads.checked = true;
    form.elements.downloads.dispatchEvent(new Event("change"));
    all.checked = true;
    form.dispatchEvent(new Event("submit", {cancelable: true}));
    await settle();
    expect(JSON.parse(window.fetch.mock.calls[1][1].body)).toEqual(expect.objectContaining({downloads: true,
        all_files: true}));
    expect(all.checked).toBe(false);
    expect(all.disabled).toBe(true);
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

test("with a Public Address set, the links are copied with it instead of the browser's address", async () => {
    render([json(200, [LINK])], "https://maps.example.com");
    await settle();
    expect(document.querySelector(".explorer-link-address").value).toBe("https://maps.example.com" + LINK.path);
});

test("each link shows whether it requires sign-in, and ticking it changes the link at once", async () => {
    const { list } = render([json(200, [{...LINK, sign_in: true}, {...LINK, token: "u".repeat(43)}]),
        json(200, {...LINK, token: "u".repeat(43), sign_in: true})]);
    await settle();
    const boxes = list.querySelectorAll("input[name=sign_in]");
    expect([...boxes].map((box) => box.checked)).toEqual([true, false]);
    expect(boxes[0].parentNode.textContent).toContain("Require Sign-In");
    boxes[1].checked = true;
    boxes[1].dispatchEvent(new Event("change"));
    await settle(); await settle();
    const [url, options] = window.fetch.mock.calls[1];
    expect(url).toBe(API + "u".repeat(43) + "/");
    expect(JSON.parse(options.body)).toEqual({sign_in: true});
    expect(boxes[1].checked).toBe(true);
    expect(boxes[1].disabled).toBe(false);
});

test("creating a link with Require Sign-In ticked asks for one", async () => {
    const { form } = render([json(200, []), json(201, {...LINK, sign_in: true}), json(200, [{...LINK, sign_in: true}])]);
    await settle();
    form.elements.sign_in.checked = true;
    form.dispatchEvent(new Event("submit", {cancelable: true}));
    await settle(); await settle();
    expect(JSON.parse(window.fetch.mock.calls[1][1].body).sign_in).toBe(true);
    expect(form.elements.sign_in.checked).toBe(false);  // the form is ready for the next link
});

test("where every link must ask for a login, Require Sign-In is ticked and fixed on the form and on each link", async () => {
    const { form, list } = render([json(200, [LINK]), json(201, {...LINK, sign_in: true}), json(200, [LINK])], null, true);
    await settle();
    const box = list.querySelector("input[name=sign_in]");
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(box.parentNode.title).toBe("Every link asks for a login.");
    form.dispatchEvent(new Event("submit", {cancelable: true}));
    await settle(); await settle();
    expect(JSON.parse(window.fetch.mock.calls[1][1].body).sign_in).toBe(true);
    expect(form.elements.sign_in.checked).toBe(true);
});

test("Embed under a link that asks for a login says it shows only to signed-in visitors", async () => {
    const { list } = render([json(200, [LINK]), json(200, {...LINK, sign_in: true})]);
    await settle();
    const row = list.querySelector(".explorer-link");
    const note = [...row.querySelectorAll(".explorer-embed p")].find((p) => p.textContent === "Asks for a login.");
    const embed = row.querySelector("button[aria-expanded]");
    embed.click();
    expect(note.hidden).toBe(true);
    embed.click();
    const box = row.querySelector("input[name=sign_in]");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle(); await settle();
    embed.click();
    expect(note.hidden).toBe(false);
});

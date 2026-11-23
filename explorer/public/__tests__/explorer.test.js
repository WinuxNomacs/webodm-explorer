const { init } = require("../explorer.js");

function render() {
    document.body.innerHTML = `
        <button type="button" data-explorer-share aria-expanded="false">Share</button>
        <div id="explorer-share" hidden>
            <input type="text" readonly value="/plugins/explorer/project/7/">
            <button type="button" data-explorer-copy data-copied="Copied"><i></i> Copy</button>
        </div>`;
    init(document);
    return {
        share: document.querySelector("[data-explorer-share]"),
        panel: document.getElementById("explorer-share"),
        input: document.querySelector("input"),
        copy: document.querySelector("[data-explorer-copy]"),
    };
}

afterEach(() => {
    jest.useRealTimers();
    delete document.execCommand;
});

test("the link shown is the page's full address", () => {
    const { input } = render();
    expect(input.value).toBe(window.location.origin + "/plugins/explorer/project/7/");
});

test("a field the browser restored with the full address doesn't get the origin twice", () => {
    document.body.innerHTML = `
        <button type="button" data-explorer-share aria-expanded="false">Share</button>
        <div id="explorer-share" hidden>
            <input type="text" readonly data-path="/plugins/explorer/project/7/"
                   value="${window.location.origin}/plugins/explorer/project/7/">
            <button type="button" data-explorer-copy data-copied="Copied">Copy</button>
        </div>`;
    init(document);
    expect(document.querySelector("input").value).toBe(window.location.origin + "/plugins/explorer/project/7/");
});

test("the Share button opens and closes the panel and says whether it is open", () => {
    const { share, panel } = render();
    share.click();
    expect(panel.hidden).toBe(false);
    expect(share.getAttribute("aria-expanded")).toBe("true");
    share.click();
    expect(panel.hidden).toBe(true);
    expect(share.getAttribute("aria-expanded")).toBe("false");
});

test("Copy copies the link and says so for a moment where the Clipboard API is unavailable", () => {
    jest.useFakeTimers();
    document.execCommand = jest.fn(() => true);
    const { copy, input } = render();
    copy.click();
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.activeElement).toBe(input);
    expect(copy.textContent).toBe("Copied");
    jest.advanceTimersByTime(1500);
    expect(copy.textContent.trim()).toBe("Copy");
});

test("a copy the browser refuses leaves the button as it was and the link selected", () => {
    document.execCommand = jest.fn(() => { throw new Error("not allowed"); });
    const { copy, input } = render();
    copy.click();
    expect(copy.textContent.trim()).toBe("Copy");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
});

test("a thumbnail that fails to load becomes the card's placeholder", () => {
    document.body.innerHTML = `<div class="explorer-card">
        <img class="explorer-thumbnail" alt="" data-placeholder-icon="fa fa-cube" src="/thumbnail">
    </div>`;
    init(document);
    document.querySelector("img").dispatchEvent(new Event("error"));
    expect(document.querySelector("img")).toBeNull();
    const placeholder = document.querySelector(".explorer-card .explorer-no-thumbnail");
    expect(placeholder.className).toContain("explorer-thumbnail");
    expect(placeholder.querySelector("i").className).toBe("fa fa-cube");
});

test("a thumbnail that already failed before the script ran is replaced at once", () => {
    document.body.innerHTML = `<div><img class="explorer-thumbnail" alt="" data-placeholder-icon="fa fa-folder-open" src="/thumbnail"></div>`;
    const img = document.querySelector("img");
    Object.defineProperty(img, "complete", { value: true });
    Object.defineProperty(img, "naturalWidth", { value: 0 });
    init(document);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".explorer-no-thumbnail i").className).toBe("fa fa-folder-open");
});

test("a thumbnail that loaded is kept", () => {
    document.body.innerHTML = `<div><img class="explorer-thumbnail" alt="" data-placeholder-icon="fa fa-cube" src="/thumbnail"></div>`;
    const img = document.querySelector("img");
    Object.defineProperty(img, "complete", { value: true });
    Object.defineProperty(img, "naturalWidth", { value: 512 });
    init(document);
    expect(document.querySelector("img")).toBe(img);
});

test("a changed scope, sort or filter on the home's toolbar applies at once; typing a search waits for Enter", () => {
    document.body.innerHTML = `
        <form data-explorer-toolbar>
            <input type="search" name="q"><select name="scope"><option>all</option><option>mine</option></select>
            <input type="checkbox" name="3d" value="1">
        </form>`;
    const form = document.querySelector("form");
    form.requestSubmit = jest.fn();
    init(document);
    document.querySelector("[name=q]").dispatchEvent(new Event("change"));
    expect(form.requestSubmit).not.toHaveBeenCalled();
    document.querySelector("select").dispatchEvent(new Event("change"));
    document.querySelector("[name='3d']").dispatchEvent(new Event("change"));
    expect(form.requestSubmit).toHaveBeenCalledTimes(2);
});

test("the toolbar leaves empty and default values out of the address", () => {
    document.body.innerHTML = `
        <form data-explorer-toolbar>
            <input type="search" name="q" value=""><select name="scope" data-default="all"><option>all</option></select>
            <select name="sort" data-default="activity"><option>activity</option><option selected>name</option></select>
        </form>`;
    init(document);
    const form = document.querySelector("form");
    form.dispatchEvent(new Event("submit"));
    expect([...form.elements].filter((f) => !f.disabled).map((f) => f.name)).toEqual(["sort"]);
});

test("a second Copy while the button says Copied still brings back its label", () => {
    jest.useFakeTimers();
    document.execCommand = jest.fn(() => true);
    const { copy } = render();
    copy.click();
    jest.advanceTimersByTime(500);
    copy.click();
    expect(copy.textContent).toBe("Copied");
    jest.advanceTimersByTime(1500);
    expect(copy.textContent.trim()).toBe("Copy");
    expect(copy.querySelector("i")).not.toBeNull();  // its icon too
});

const { init } = require("../explorer.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function html(status, body) {
    return Promise.resolve({ok: status < 400, status, text: () => Promise.resolve(body)});
}

function pane(id) {
    return `<div class="explorer-pane-body" data-pane-project="${id}"><h3>Project ${id}</h3></div>`;
}

function render(responses) {
    window.fetch = jest.fn(() => responses.shift());
    window.history.replaceState(null, "", "/plugins/explorer/?view=list");
    document.body.innerHTML = `
        <div class="explorer-list" data-explorer-list data-pane-url="/plugins/explorer/list/" data-error="Could not load.">
            <nav class="explorer-folder"><ul>
                <li><a class="explorer-folder-item active" href="?view=list&project=1" data-project="1" aria-current="true">One</a></li>
                <li><a class="explorer-folder-item" href="?view=list&project=2" data-project="2">Two</a></li>
                <li><a class="explorer-folder-item" href="?view=list&project=3" data-project="3">Three</a></li>
            </ul></nav>
            <section class="explorer-pane">
                <a class="explorer-pane-back" href="?view=list">Back to Projects</a>
                <div class="explorer-pane-content">${pane(1)}</div>
            </section>
        </div>`;
    init(document);
    return {
        list: document.querySelector("[data-explorer-list]"),
        items: [...document.querySelectorAll(".explorer-folder-item")],
        content: document.querySelector(".explorer-pane-content"),
        back: document.querySelector(".explorer-pane-back"),
    };
}

afterEach(() => {
    delete window.fetch;
    jest.useRealTimers();
});

test("choosing a project swaps the pane in place and keeps the address", async () => {
    const { list, items, content } = render([html(200, pane(2))]);
    items[1].click();
    expect(items[1].getAttribute("aria-current")).toBe("true");
    expect(items[1].classList.contains("theme-background-highlight")).toBe(true);
    expect(items[0].hasAttribute("aria-current")).toBe(false);
    expect(content.getAttribute("aria-busy")).toBe("true");
    expect(window.location.search).toBe("?view=list&project=2");
    expect(list.classList.contains("explorer-list-chosen")).toBe(true);
    await settle();
    expect(window.fetch).toHaveBeenCalledWith("/plugins/explorer/list/2/", expect.objectContaining({credentials: "same-origin"}));
    expect(content.querySelector("[data-pane-project]").getAttribute("data-pane-project")).toBe("2");
    expect(content.hasAttribute("aria-busy")).toBe(false);
});

test("a later choice wins over an answer still on its way", async () => {
    let first;
    const slow = new Promise((resolve) => { first = resolve; });
    const { items, content } = render([slow, html(200, pane(3))]);
    items[1].click();
    items[2].click();
    await settle();
    first({ok: true, status: 200, text: () => Promise.resolve(pane(2))});
    await settle();
    expect(content.querySelector("[data-pane-project]").getAttribute("data-pane-project")).toBe("3");
});

test("a pane that can't be loaded says so", async () => {
    const { items, content } = render([html(500, "")]);
    items[2].click();
    await settle();
    expect(content.textContent).toBe("Could not load.");
});

test("Up and Down move the selection and load where they stop", async () => {
    jest.useFakeTimers();
    const { items } = render([html(200, pane(3))]);
    items[0].focus();
    items[0].dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true}));
    items[1].dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true}));
    expect(document.activeElement).toBe(items[2]);
    expect(items[2].getAttribute("aria-current")).toBe("true");
    expect(window.fetch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(window.fetch).toHaveBeenCalledTimes(1);
    expect(window.fetch.mock.calls[0][0]).toBe("/plugins/explorer/list/3/");
    expect(window.location.search).toBe("?view=list&project=3");
    // Past the ends nothing moves
    items[2].dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true}));
    expect(document.activeElement).toBe(items[2]);
});

test("a click with a modifier key opens the page as usual", () => {
    const { items } = render([]);
    const click = new MouseEvent("click", {bubbles: true, cancelable: true, ctrlKey: true});
    items[1].dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(window.fetch).not.toHaveBeenCalled();
});

test("Back to Projects shows the folder pane again, and the browser's Back returns to the project", async () => {
    const { list, items, back } = render([html(200, pane(2)), html(200, pane(1))]);
    items[1].click();
    await settle();
    back.click();
    expect(list.classList.contains("explorer-list-chosen")).toBe(false);
    expect(window.location.search).toBe("?view=list");
    expect(document.activeElement).toBe(items[1]);
    // Forward to the project: the pane already shows it, nothing loads
    window.history.replaceState(null, "", "/plugins/explorer/?view=list&project=2");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(list.classList.contains("explorer-list-chosen")).toBe(true);
    expect(window.fetch).toHaveBeenCalledTimes(1);
    // Back to the first project: it loads
    window.history.replaceState(null, "", "/plugins/explorer/?view=list&project=1");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settle();
    expect(window.fetch).toHaveBeenCalledTimes(2);
    expect(items[0].getAttribute("aria-current")).toBe("true");
});

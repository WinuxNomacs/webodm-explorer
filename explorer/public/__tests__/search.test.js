const { init } = require("../explorer.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const DELAY = 250;

function html(status, body) {
    return Promise.resolve({ok: status < 400, status, text: () => Promise.resolve(body)});
}

// The page the server answers for a search: the toolbar's view switch and the results
function page(q, names) {
    return `<form data-explorer-toolbar><div class="explorer-view-switch"><a href="?q=${q}&view=grid">Grid</a></div></form>
        <div data-explorer-results>${names.map((name) => `<span class="explorer-card-title">${name}</span>`).join("")}</div>`;
}

function render(responses, search = "") {
    window.fetch = jest.fn(() => responses.shift());
    window.history.replaceState(null, "", "/plugins/explorer/" + search);
    document.body.innerHTML = `
        <form class="explorer-toolbar" method="get" data-explorer-toolbar data-search-error="Could not search.">
            <input type="search" name="q" value="">
            <button type="submit">Search</button>
            <select name="scope" data-default="all"><option value="all" selected>All</option><option value="mine">Mine</option></select>
            <input type="hidden" name="view" value="grid" data-default="grid">
            <label><input type="checkbox" name="3d" value="1"> Has 3D</label>
            <div class="explorer-view-switch"><a href="?view=grid">Grid</a></div>
        </form>
        <div data-explorer-results><span class="explorer-card-title">Alpha</span><span class="explorer-card-title">Beta</span></div>`;
    init(document);
    const form = document.querySelector("form");
    return {
        form,
        box: form.elements.q,
        button: form.querySelector("button"),
        names: () => [...document.querySelectorAll("[data-explorer-results] .explorer-card-title")].map((e) => e.textContent),
    };
}

function type(box, value) {
    box.value = value;
    box.dispatchEvent(new Event("input"));
}

afterEach(() => {
    delete window.fetch;
    jest.useRealTimers();
});

test("one letter filters nothing; the second filters after a pause, in place, with the address updated", async () => {
    jest.useFakeTimers();
    const { box, names } = render([html(200, page("al", ["Alpha"]))]);
    type(box, "a");
    jest.advanceTimersByTime(DELAY * 4);
    expect(window.fetch).not.toHaveBeenCalled();
    type(box, "al");
    jest.advanceTimersByTime(DELAY - 1);
    expect(window.fetch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(window.fetch).toHaveBeenCalledWith("?q=al", expect.objectContaining({credentials: "same-origin"}));
    jest.useRealTimers();
    await settle();
    await settle();
    expect(names()).toEqual(["Alpha"]);
    expect(window.location.search).toBe("?q=al");
    expect(document.querySelector("form .explorer-view-switch a").getAttribute("href")).toBe("?q=al&view=grid");
    expect(document.activeElement === box || document.activeElement === document.body).toBe(true);
});

test("typing quickly asks once, for what the box says when the typing stops", () => {
    jest.useFakeTimers();
    const { box } = render([html(200, page("alp", ["Alpha"]))]);
    type(box, "al");
    jest.advanceTimersByTime(100);
    type(box, "alp");
    jest.advanceTimersByTime(DELAY);
    expect(window.fetch).toHaveBeenCalledTimes(1);
    expect(window.fetch.mock.calls[0][0]).toBe("?q=alp");
});

test("emptying the box shows everything again", async () => {
    jest.useFakeTimers();
    const { box, names } = render([html(200, page("al", ["Alpha"])), html(200, page("", ["Alpha", "Beta", "Gamma"]))]);
    type(box, "al");
    jest.advanceTimersByTime(DELAY);
    type(box, "");
    jest.advanceTimersByTime(DELAY);
    expect(window.fetch.mock.calls[1][0]).toBe("/plugins/explorer/");
    jest.useRealTimers();
    await settle();
    await settle();
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);
});

test("Enter searches at once, a single letter included, without loading the page", async () => {
    const { form, box, button, names } = render([html(200, page("b", ["Beta"]))]);
    box.value = "b";
    const submit = new Event("submit", {cancelable: true});
    submit.submitter = button;
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(window.fetch.mock.calls[0][0]).toBe("?q=b");
    await settle();
    await settle();
    expect(names()).toEqual(["Beta"]);
});

test("the search keeps the filters and leaves defaults out of the address", () => {
    jest.useFakeTimers();
    const { form, box } = render([html(200, page("al", []))]);
    form.elements.scope.value = "mine";
    form.elements["3d"].checked = true;
    type(box, "al pha");
    jest.advanceTimersByTime(DELAY);
    expect(window.fetch.mock.calls[0][0]).toBe("?q=al%20pha&scope=mine&3d=1");
});

test("a new search in List view leaves the chosen project, to open on the search's results", () => {
    jest.useFakeTimers();
    const { form, box } = render([html(200, page("al", []))], "?view=list&project=7");
    form.elements.view.value = "list";
    type(box, "al");
    jest.advanceTimersByTime(DELAY);
    expect(window.fetch.mock.calls[0][0]).toBe("?q=al&view=list");
});

test("a changed filter still loads the page as before", () => {
    const { form } = render([]);
    const submit = new Event("submit", {cancelable: true});
    form.dispatchEvent(submit);  // requestSubmit() from a changed filter: no submitter
    expect(submit.defaultPrevented).toBe(false);
    expect(window.fetch).not.toHaveBeenCalled();
});

test("an older answer arriving after a newer one is dropped", async () => {
    jest.useFakeTimers();
    let answerOld;
    const old = new Promise((resolve) => { answerOld = resolve; });
    const { box, names } = render([old, html(200, page("be", ["Beta"]))]);
    type(box, "al");
    jest.advanceTimersByTime(DELAY);
    type(box, "be");
    jest.advanceTimersByTime(DELAY);
    jest.useRealTimers();
    await settle();
    await settle();
    answerOld({ok: true, status: 200, text: () => Promise.resolve(page("al", ["Alpha"]))});
    await settle();
    await settle();
    expect(names()).toEqual(["Beta"]);
    expect(window.location.search).toBe("?q=be");
});

test("a failed search says so, keeps the results, and the next keystroke tries again", async () => {
    jest.useFakeTimers();
    const { box, names } = render([html(500, "oops"), html(200, page("al", ["Alpha"]))]);
    type(box, "al");
    jest.advanceTimersByTime(DELAY);
    jest.useRealTimers();
    await settle();
    await settle();
    expect(document.querySelector(".explorer-search-error").textContent).toBe("Could not search.");
    expect(names()).toEqual(["Alpha", "Beta"]);
    expect(window.location.search).toBe("");
    jest.useFakeTimers();
    type(box, "al");
    jest.advanceTimersByTime(DELAY);
    jest.useRealTimers();
    await settle();
    await settle();
    expect(names()).toEqual(["Alpha"]);
    expect(document.querySelector(".explorer-search-error")).toBeNull();
});

test("List view's pane asks for the search's tasks, and Show All Tasks for all of them", async () => {
    window.fetch = jest.fn(() => html(200, `<div data-pane-project="2">Two
        <a href="/plugins/explorer/project/2/" data-pane-all="2">Show All Tasks</a></div>`));
    window.history.replaceState(null, "", "/plugins/explorer/?view=list&q=roof");
    document.body.innerHTML = `
        <div data-explorer-results>
        <div class="explorer-list" data-explorer-list data-pane-url="/plugins/explorer/list/" data-error="Could not load.">
            <nav class="explorer-folder"><ul>
                <li><a class="explorer-folder-item active" href="?view=list&q=roof&project=1" data-project="1">One</a></li>
                <li><a class="explorer-folder-item" href="?view=list&q=roof&project=2" data-project="2">Two</a></li>
            </ul></nav>
            <section class="explorer-pane"><div class="explorer-pane-content"></div></section>
        </div></div>`;
    init(document);
    document.querySelectorAll(".explorer-folder-item")[1].dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, button: 0}));
    expect(window.fetch.mock.calls[0][0]).toBe("/plugins/explorer/list/2/?q=roof");
    await settle();
    await settle();
    const all = document.querySelector("[data-pane-all]");
    const click = new MouseEvent("click", {bubbles: true, cancelable: true, button: 0});
    all.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(window.fetch.mock.calls[1][0]).toBe("/plugins/explorer/list/2/?q=roof&all=1");
});

function renderResults(responses) {
    window.fetch = jest.fn(() => responses.shift());
    window.history.replaceState(null, "", "/plugins/explorer/?q=roof&view=list&scope=mine");
    document.body.innerHTML = `
        <div data-explorer-results>
        <div class="explorer-list" data-explorer-list data-pane-url="/plugins/explorer/list/" data-error="Could not load.">
            <nav class="explorer-folder"><ul>
                <li><a class="explorer-folder-item explorer-folder-results active" href="?q=roof&view=list&scope=mine" data-project="">Search Results</a></li>
                <li><a class="explorer-folder-item" href="?q=roof&view=list&scope=mine&project=2" data-project="2">Two</a>
                    <ul class="explorer-folder-tasks"><li><a href="/plugins/explorer/project/2/task/t1/">Roof</a></li></ul></li>
            </ul></nav>
            <section class="explorer-pane"><div class="explorer-pane-content">
                <div data-pane-project=""><a href="?view=list&q=roof&project=2" data-pane-open="2">Two</a></div>
            </div></section>
        </div></div>`;
    init(document);
}

const click = (el) => {
    const event = new MouseEvent("click", {bubbles: true, cancelable: true, button: 0});
    el.dispatchEvent(event);
    return event;
};

test("a project's heading in Search Results opens its pane, narrowed to the search, in place", async () => {
    renderResults([html(200, `<div data-pane-project="2"><a href="?view=list&q=roof" data-pane-results>Back to Search Results</a></div>`)]);
    const event = click(document.querySelector("[data-pane-open]"));
    expect(event.defaultPrevented).toBe(true);
    expect(window.fetch.mock.calls[0][0]).toBe("/plugins/explorer/list/2/?q=roof");
    expect(window.location.search).toBe("?q=roof&view=list&scope=mine&project=2");
    expect(document.querySelector("[data-project='2']").classList.contains("active")).toBe(true);
    await settle();
    await settle();
    expect(document.querySelector("[data-pane-results]")).not.toBeNull();
});

test("Back to Search Results loads the results for the search and filters, without the project", async () => {
    renderResults([html(200, `<div data-pane-project="2"><a href="?view=list&q=roof" data-pane-results>Back</a></div>`),
        html(200, `<div data-pane-project="">Results</div>`)]);
    click(document.querySelector("[data-pane-open]"));
    await settle();
    await settle();
    click(document.querySelector("[data-pane-results]"));
    expect(window.fetch.mock.calls[1][0]).toBe("/plugins/explorer/list/results/?q=roof&view=list&scope=mine");
    expect(window.location.search).toBe("?q=roof&view=list&scope=mine");
    expect(document.querySelector(".explorer-folder-results").classList.contains("active")).toBe(true);
});

test("a matching task under its project in the folder pane is a plain link to the task's page", () => {
    renderResults([]);
    const event = click(document.querySelector(".explorer-folder-tasks a"));
    expect(event.defaultPrevented).toBe(false);
    expect(window.fetch).not.toHaveBeenCalled();
});

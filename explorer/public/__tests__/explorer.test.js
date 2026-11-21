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

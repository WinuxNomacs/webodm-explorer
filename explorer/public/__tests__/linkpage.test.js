const { keepOnScreen } = require("../linkpage.js");

test("a bar menu that would open off the left edge opens rightwards instead, and back when there is room", () => {
    document.body.innerHTML = `<ul class="dropdown-menu dropdown-menu-right"></ul>`;
    const menu = document.querySelector("ul");
    let left = -40;
    menu.getBoundingClientRect = () => ({left: menu.classList.contains("explorer-menu-left") ? 8 : left, right: 200});
    keepOnScreen(menu);
    expect(menu.classList.contains("explorer-menu-left")).toBe(true);
    left = 120;
    keepOnScreen(menu);
    expect(menu.classList.contains("explorer-menu-left")).toBe(false);
});

test("a Download menu that would open past the right edge on a phone opens leftwards instead", () => {
    document.body.innerHTML = `<ul class="dropdown-menu"></ul>`;
    Object.defineProperty(document.documentElement, "clientWidth", {configurable: true, value: 320});
    const menu = document.querySelector("ul");
    let right = 380;
    menu.getBoundingClientRect = () => ({left: 140, right: menu.classList.contains("explorer-menu-right") ? 300 : right});
    keepOnScreen(menu);
    expect(menu.classList.contains("explorer-menu-right")).toBe(true);
    expect(menu.classList.contains("explorer-menu-left")).toBe(false);
    right = 300;
    keepOnScreen(menu);
    expect(menu.classList.contains("explorer-menu-right")).toBe(false);
    delete document.documentElement.clientWidth;
});

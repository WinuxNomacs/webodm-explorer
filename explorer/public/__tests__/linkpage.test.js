const { keepOnScreen } = require("../linkpage.js");

test("a bar menu that would open off the left edge opens rightwards instead, and back when there is room", () => {
    document.body.innerHTML = `<ul class="dropdown-menu dropdown-menu-right"></ul>`;
    const menu = document.querySelector("ul");
    let left = -40;
    menu.getBoundingClientRect = () => ({left: menu.classList.contains("explorer-menu-left") ? 8 : left});
    keepOnScreen(menu);
    expect(menu.classList.contains("explorer-menu-left")).toBe(true);
    left = 120;
    keepOnScreen(menu);
    expect(menu.classList.contains("explorer-menu-left")).toBe(false);
});

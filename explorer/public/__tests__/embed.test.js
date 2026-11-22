const { init, embedCode } = require("../explorer.js");

const API = "/api/plugins/explorer/projects/7/links/";
const PATH = "/plugins/explorer/s/" + "t".repeat(43) + "/";
const LINK = {token: "t".repeat(43), label: "Client", created: "2026-11-21T10:00:00+00:00", expires: null, path: PATH};
const VIEWS = [{task: "Roof", views: [{label: "Map", path: "map/T1/"}, {label: "Point Cloud", path: "3d/T1/?t=cloud"}]}];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(projectName) {
    window.fetch = jest.fn(() => Promise.resolve({ok: true, status: 200, json: () => Promise.resolve([LINK])}));
    document.body.innerHTML = `
        <script type="application/json" id="explorer-embed-views">${JSON.stringify(VIEWS)}</script>
        <div class="explorer-links" data-links-api="${API}" data-copy="Copy" data-copied="Copied" data-revoke="Revoke"
             data-untitled="Untitled" data-never="Never" data-expires="Expires %(date)s" data-none="None"
             data-downloads="Allow Downloads" data-open="Open" data-embed="Embed" data-embed-page="The Whole Page"
             data-embed-label="Show" data-embed-code="Embed Code" data-embed-note="Anyone who can read it."
             data-project-name="${projectName}" data-error="Error">
            <div class="explorer-links-list"></div>
            <form class="explorer-link-form"><input type="hidden" name="csrfmiddlewaretoken" value="c">
                <input name="label"><select name="expires_days"><option value="30">30</option></select>
                <input type="checkbox" name="downloads"><button type="submit">Create</button></form>
            <div class="explorer-links-error" hidden></div>
        </div>`;
    init(document);
}

afterEach(() => { delete window.fetch; });

test("the embed code frames the view in the embed layout, with fullscreen allowed", () => {
    expect(embedCode("https://odm.example/s/T/", "map/T1/", "Barn")).toBe(
        '<iframe src="https://odm.example/s/T/map/T1/?embed=1" title="Barn" width="100%" height="480" ' +
        'style="border: 0;" allow="fullscreen" allowfullscreen loading="lazy"></iframe>');
    expect(embedCode("https://odm.example/s/T/", "3d/T1/?t=cloud", "Barn")).toContain('3d/T1/?t=cloud&amp;embed=1"');
    expect(embedCode("https://odm.example/s/T/", "", "Barn")).toContain('src="https://odm.example/s/T/?embed=1"');
});

test("a project name can't break out of the iframe's attributes", () => {
    const code = embedCode("https://o/s/T/", "", 'x" onload="alert(1)" <b>');
    expect(code).toContain('title="x&quot; onload=&quot;alert(1)&quot; &lt;b&gt;"');
    const holder = document.createElement("div");
    holder.innerHTML = code;
    expect(holder.querySelector("iframe").hasAttribute("onload")).toBe(false);
});

test("Embed under a link opens a picker of the page and each task's views, and the code follows the choice", async () => {
    render("Barn &amp; Shed");
    await settle(); await settle();
    const button = [...document.querySelectorAll(".explorer-link button")].find((b) => b.textContent === "Embed");
    const panel = document.querySelector(".explorer-embed");
    expect(panel.hidden).toBe(true);
    button.click();
    expect(panel.hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const select = panel.querySelector("select");
    expect([...select.options].map((o) => o.textContent)).toEqual(["The Whole Page", "Map", "Point Cloud"]);
    expect(select.querySelector("optgroup").label).toBe("Roof");
    const code = panel.querySelector("textarea");
    expect(code.value).toContain(`src="http://localhost${PATH}?embed=1"`);
    expect(code.value).toContain('title="Barn &amp; Shed"');
    select.value = "3d/T1/?t=cloud";
    select.dispatchEvent(new Event("change"));
    expect(code.value).toContain(`src="http://localhost${PATH}3d/T1/?t=cloud&amp;embed=1"`);
    expect(panel.textContent).toContain("Anyone who can read it.");
});

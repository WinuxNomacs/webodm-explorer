const Tree = require("../ept-tree.js");

const EPT = {
    dataType: "laszip", hierarchyType: "json", span: 128, points: 1000,
    bounds: [0, 0, 0, 100, 100, 100], boundsConforming: [10, 20, 30, 90, 80, 70],
};

function tree(hierarchy) {
    const t = Tree.createTree(Tree.parseEpt(EPT));
    if (hierarchy) Tree.addHierarchy(t, hierarchy);
    return t;
}

// Looking down from high above the centre, so every node is in front of the camera
function view(overrides) {
    return {position: [0, 0, 1000], fov: 60, height: 1000, budget: 1e9, minPixels: 0, visible: () => true,
        loaded: () => true, ...overrides};
}

test("coordinates are made relative to the centre of the conforming bounds", () => {
    const info = Tree.parseEpt(EPT);
    expect(info.origin).toEqual([50, 50, 50]);
    expect(info.bounds).toEqual([-50, -50, -50, 50, 50, 50]);
    expect(info.conforming).toEqual([-40, -30, -20, 40, 30, 20]);
});

test("only LAZ EPT with a JSON hierarchy and valid bounds is accepted", () => {
    expect(() => Tree.parseEpt({...EPT, dataType: "binary"})).toThrow(/dataType/);
    expect(() => Tree.parseEpt({...EPT, hierarchyType: "gzip"})).toThrow(/hierarchyType/);
    expect(() => Tree.parseEpt({...EPT, bounds: [0, 0, 0, 1, 1]})).toThrow(/bounds/);
    expect(() => Tree.parseEpt({...EPT, span: 0})).toThrow(/span/);
    expect(() => Tree.parseEpt(null)).toThrow();
    expect(Tree.parseEpt({...EPT, boundsConforming: undefined}).origin).toEqual([50, 50, 50]);
});

test("a node's cube is the root's halved at each depth", () => {
    const root = [-50, -50, -50, 50, 50, 50];
    expect(Tree.keyBounds(root, 0, 0, 0, 0)).toEqual(root);
    expect(Tree.keyBounds(root, 1, 1, 0, 1)).toEqual([0, -50, 0, 50, 0, 50]);
    expect(Tree.keyBounds(root, 2, 3, 3, 3)).toEqual([25, 25, 25, 50, 50, 50]);
});

test("spacing halves at each depth", () => {
    const info = Tree.parseEpt(EPT);
    expect(Tree.spacing(info, 0)).toBeCloseTo(100 / 128);
    expect(Tree.spacing(info, 3)).toBeCloseTo(100 / 128 / 8);
});

test("the hierarchy builds the tree, ignoring orphans and entries that aren't counts", () => {
    const t = tree({"0-0-0-0": 10, "1-0-0-0": 5, "1-1-1-1": 6, "2-0-0-0": 2, "3-7-7-7": 9, "1-1-0-0": 0,
        "x-1-2-3": 4, "1-0-1-0": "7"});
    expect(t.root.count).toBe(10);
    expect(t.root.pendingHierarchy).toBe(false);
    expect(t.root.children.map((n) => n.key).sort()).toEqual(["1-0-0-0", "1-1-1-1"]);
    expect(t.nodes["2-0-0-0"].parent.key).toBe("1-0-0-0");
    expect(t.nodes["3-7-7-7"]).toBeUndefined();
    expect(t.nodes["1-1-0-0"]).toBeUndefined();
});

test("a -1 entry waits for its own hierarchy file, which fills it in", () => {
    const t = tree({"0-0-0-0": 10, "1-0-0-0": -1});
    const node = t.nodes["1-0-0-0"];
    expect(node.pendingHierarchy).toBe(true);
    expect(Tree.select(t, view()).hierarchy).toEqual([node]);
    Tree.addHierarchy(t, {"1-0-0-0": 4, "2-1-1-1": 3});
    expect(node.pendingHierarchy).toBe(false);
    expect(node.count).toBe(4);
    expect(node.children.map((n) => n.key)).toEqual(["2-1-1-1"]);
    expect(Tree.select(t, view()).hierarchy).toEqual([]);
});

test("selection starts at the root and goes deeper only below loaded nodes", () => {
    const t = tree({"0-0-0-0": 10, "1-0-0-0": 5, "2-0-0-0": 2});
    const keys = (loaded) => Tree.select(t, view({loaded})).nodes.map((n) => n.key);
    expect(keys(() => false)).toEqual(["0-0-0-0"]);
    expect(keys((n) => n.depth === 0)).toEqual(["0-0-0-0", "1-0-0-0"]);
    expect(keys(() => true)).toEqual(["0-0-0-0", "1-0-0-0", "2-0-0-0"]);
});

test("the point budget stops selection, though the root always shows", () => {
    const t = tree({"0-0-0-0": 10, "1-0-0-0": 5, "1-1-1-1": 6});
    // From above, the upper child (6 points) is nearer and comes first; then the budget is spent
    expect(Tree.select(t, view({budget: 16})).nodes.map((n) => n.key)).toEqual(["0-0-0-0", "1-1-1-1"]);
    expect(Tree.select(t, view({budget: 16})).points).toBe(16);
    expect(Tree.select(t, view({budget: 21})).points).toBe(21);
    expect(Tree.select(t, view({budget: 3})).nodes.map((n) => n.key)).toEqual(["0-0-0-0"]);
});

test("nodes small on screen and nodes out of view are left out", () => {
    const t = tree({"0-0-0-0": 10, "1-0-0-0": 5, "1-1-1-1": 6});
    expect(Tree.select(t, view({minPixels: 1e6})).nodes.map((n) => n.key)).toEqual(["0-0-0-0"]);
    const visible = (n) => n.key !== "1-1-1-1";
    expect(Tree.select(t, view({visible})).nodes.map((n) => n.key)).toEqual(["0-0-0-0", "1-0-0-0"]);
    expect(Tree.select(t, view({visible: () => false})).nodes).toEqual([]);
});

test("nearer nodes come first, and a node around the camera comes before all", () => {
    const t = tree({"0-0-0-0": 10, "1-0-0-0": 5, "1-1-1-1": 6});
    // Near the corner of 1-1-1-1 (relative coordinates: it spans 0..50 on each axis)
    expect(Tree.select(t, view({position: [200, 200, 200]})).nodes.map((n) => n.key))
        .toEqual(["0-0-0-0", "1-1-1-1", "1-0-0-0"]);
    expect(Tree.select(t, view({position: [-25, -25, -25], budget: 15})).nodes.map((n) => n.key))
        .toEqual(["0-0-0-0", "1-0-0-0"]);
});

test("each shown node knows the depth of the deepest shown node below it", () => {
    const t = tree({"0-0-0-0": 10, "1-0-0-0": 5, "1-1-1-1": 6, "2-0-0-0": 2});
    const deepest = Tree.deepestShown([t.root, t.nodes["1-0-0-0"], t.nodes["1-1-1-1"], t.nodes["2-0-0-0"]]);
    expect(deepest).toEqual({"0-0-0-0": 2, "1-0-0-0": 2, "1-1-1-1": 1, "2-0-0-0": 2});
});

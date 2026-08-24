import Foundation

// =============================================================================================
//  What the menu lists.
//
//  The rule: only aliases whose upstream is answering, plus the reserved dashboard alias,
//  which is listed whatever it is doing because it is the way back into the app.
//
//  AliasMenuList is a pure function of (aliases, liveness), so all of this runs with no menu,
//  no AppKit and no machine state.
// =============================================================================================

private func alias(
    _ id: String, _ name: String, port: Int = 3000, enabled: Bool = true, reserved: Bool = false
) -> AliasEntry {
    AliasEntry(
        id: id, name: name, port: port, ip: "127.0.0.\(port % 200 + 2)", enabled: enabled,
        reserved: reserved, description: nil)
}

private let dashboard = alias("index", "index", port: 7788, reserved: true)
private let api = alias("a", "api")
private let shop = alias("b", "shop", port: 4000)
private let blog = alias("c", "blog", port: 5000)

private func build(_ aliases: [AliasEntry], _ up: [String: Bool]) -> AliasMenuList {
    AliasMenuList.build(aliases: aliases, up: up)
}

func runMenuTests() {
    print("AliasMenuList.build() — only the live ones")

    let someLive = build([dashboard, api, shop, blog], ["index": true, "a": true, "b": false, "c": false])
    check(
        someLive.shown.map { $0.id } == ["index", "a"],
        "an alias nothing is listening on is left out of the menu")
    check(someLive.hiddenCount == 2, "and counted as hidden")
    check(
        someLive.hiddenNote == "2 more not answering — hidden",
        "hidden is never silent: the count is on screen")
    check(someLive.caption == nil, "with something live, there is no empty-state caption")

    let oneHidden = build([dashboard, api, shop], ["index": true, "a": true, "b": false])
    check(oneHidden.hiddenNote == "1 more not answering — hidden", "the note is singular for one")

    // -- the reserved alias is not a project alias, and not optional ---------------------------

    let dashboardDown = build([dashboard, api], ["index": false, "a": true])
    check(
        dashboardDown.shown.map { $0.id } == ["index", "a"],
        "the dashboard's own alias is listed even when it is not answering — it is the way back in")
    check(
        dashboardDown.hiddenCount == 0,
        "and it is never counted as a hidden project alias")

    let onlyDashboard = build([dashboard, api, shop], ["index": true, "a": false, "b": false])
    check(onlyDashboard.shown.map { $0.id } == ["index"], "with nothing live, only the dashboard is listed")
    check(
        onlyDashboard.caption == "None of your 2 aliases is answering right now — start a dev server",
        "an empty list is a sentence, not an empty region")
    check(
        onlyDashboard.hiddenNote == nil,
        "and the caption already says it, so the hidden note would be a second copy")

    let single = build([dashboard, api], ["index": true, "a": false])
    check(
        single.caption == "Your alias is not answering right now — start a dev server",
        "one alias reads as one alias")

    // -- fresh install --------------------------------------------------------------------------

    let fresh = build([dashboard], ["index": true])
    check(fresh.shown.map { $0.id } == ["index"], "a fresh install lists the dashboard alias")
    check(
        fresh.caption == "No aliases yet — add one in the dashboard",
        "and says what to do rather than that nothing is answering")
    check(fresh.hiddenCount == 0, "nothing is hidden when there is nothing to hide")

    let nothingAtAll = build([], [:])
    check(nothingAtAll.shown.isEmpty, "no config at all shows no rows")
    check(nothingAtAll.caption != nil, "and still says something")

    // -- what counts as live ---------------------------------------------------------------------

    check(
        !AliasMenuList.isLive(alias("d", "off", enabled: false), up: ["d": true]),
        "a disabled alias is never live, whatever is listening on its port")
    check(
        !AliasMenuList.isLive(api, up: [:]),
        "an alias the poller has not answered for yet is not claimed to be live")
    check(AliasMenuList.isLive(api, up: ["a": true]), "enabled plus a listening port is live")

    let disabled = build([dashboard, alias("d", "off", enabled: false)], ["index": true])
    check(
        disabled.shown.map { $0.id } == ["index"] && disabled.hiddenCount == 1,
        "a disabled alias is hidden and counted, not silently dropped")

    // -- order ------------------------------------------------------------------------------------

    let ordered = build([api, dashboard, shop], ["a": true, "index": true, "b": true])
    check(
        ordered.shown.map { $0.id } == ["index", "a", "b"],
        "the dashboard alias leads, then the live ones in config order")
}

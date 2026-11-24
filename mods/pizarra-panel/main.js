// mod.open:pizarra-panel (the key) opens the board beside the terminal, or closes it.
// A mod of its own: when a copy of pizarra closes, another one that's just starting
// can lose the calls it was waiting for.
import { View, div } from "gpui-kit";
import { checking, closeOverlay, focused, panes, props, run, spaces } from "herdr";

export default class PizarraPanel extends View {
  init(_props, cx) {
    if (checking()) return;
    const overlay = props()?.overlay;
    cx.timer.after(1, () => {
      const at = focused();
      const space = at?.space ?? spaces().find((s) => s.active)?.id;
      const tab = at?.tab ?? spaces().find((s) => s.active)?.tabs.find((x) => x.active)?.id;
      const open = panes().find((p) => p.mod === "pizarra" && p.tab === tab);
      if (overlay) closeOverlay(overlay);
      if (open) run("pane.close", { pane: open.pane });
      else run("pane.split", { direction: "right", mod: "pizarra", props: { space } });
    });
  }

  render() { return div(); }
}

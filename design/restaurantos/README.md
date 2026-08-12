# RestaurantOS Design System

The design language for the RestaurantOS platform, POS terminal, KDS, and (later) the operator analytics console.

**Derived from the [Wise design language](../../../006_Design%20Templates/awesome-design-md-add-issue-template/design-md/wise/)** (chosen from 54 candidate themes for being the only one strong on both surfaces: touch POS terminal and analytics console), with three POS-specific adaptations:

1. **Night mode**, a full warm-black dark theme (bars, kitchens, dim dining rooms), not an inverted afterthought.
2. **Service-status palette**, four state triples (info/new, amber/working, green/ready, red/late), each with solid + wash + line tokens, plus the lime/green rule that keeps the brand CTA and the "ready" status unmistakable.
3. **Touch layer**, 44px minimum targets (48px primary), press feedback, hover-independence, safe-area handling.

Typography drops Wise's proprietary display face for Inter (free) at heavier weights; money is always tabular numerals.

## Files

| File | Description |
|------|-------------|
| `DESIGN.md` | Complete design system documentation (9 sections) |
| `preview.html` | Interactive design token catalog, Day mode |
| `preview-dark.html` | Interactive design token catalog, Night mode |

Open the previews by double-clicking, they are self-contained, zero-dependency, and work offline, like everything in this repo.

Use `DESIGN.md` as the reference for AI agents (Claude Code) generating RestaurantOS UI. Section 9 contains the agent prompt guide and quick color reference.

*Concept prototype, all demo data fictional.*

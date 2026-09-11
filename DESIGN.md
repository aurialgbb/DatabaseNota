# Database Nota visual refresh

Latest direction: the user replaced green/mint with blue SaaS styling. The workspace now uses a neutral gray-white canvas, blue primary actions (#2456c5), restrained pale-blue selection, and neutral table surfaces. Existing green illustrations remain artwork accents; no raster recoloring was performed. The vector mark uses blue.

Preview interaction correction: navigation, input tabs, electricity tabs, source/month/year selects and date inputs work locally. Backend actions open an explanatory dialog instead of silently disabled buttons. This does not implement backend operations or bypass authentication. Earlier descriptions of the preview disabling every button are superseded by this correction.

Scope: new native application logo, hijab login illustration, compact menu banners, and a shared green/mint workspace theme for navigation, forms, tables, buttons and dialogs. Existing transaction workflows are retained. The legacy GAS source and frozen baseline remain intact.

Design read: branch receipt administration for store and tax staff, using the user's saas-flat-2d reference. ENERGY 2 / RHYTHM 2 / MOTION 1. Anti-slop applied during implementation, as requested.

Import preview: the dialog puts the pending decision first. Real counts summarize the scope, a scrollable list preserves every row, and status color distinguishes add, update, delete, and unchanged records. Updates show old and new values so users can review the actual effect before confirming. Account previews hide passwords and expose duplicate-branch warnings. The compact two-column mobile reflow prevents horizontal overflow without reducing text size.

Master Link controls: the URL field uses one border and moves its focus state to the complete control so it reads as one input. URL editing stays available without entering branch-edit mode; the pencil action is reserved for branch name and type. Branch search is a plain live filter because users already know the name or ID they need and do not benefit from opening a long dropdown.

- Forest green and sage come from the supplied illustration reference; they connect the mark and paperwork illustrations.
- Receipt silhouette plus N gives the logo a product-specific meaning and stays readable at small sizes. SVG keeps it crisp without a raster payload.
- Login illustration depicts receipt checking, the actual work of this application. The character is an illustration, not a staff portrait.
- Login keeps its existing form hierarchy. A compact illustration remains visible on mobile instead of consuming a full screen.
- Banners identify each menu's task in one sentence. No statistics, fake records, promises or extra actions are added.
- Paper and tray artwork connects the banner series; capture screens use a pale green surface and administration screens a restrained square edge.
- Existing app typography is retained to avoid changing unrelated working screens. The standalone visual gallery uses a system font and no font download.
- Light paper surfaces reflect the receipts being checked. No extra theme feature is introduced by this asset refresh.
- Images use WebP: login 38,262 bytes, banner 8,098 bytes. One shared banner file is cached across the menu series.
- No perpetual animation is added. Reduced-motion preferences are respected.

Generation: built-in imagegen, style-reference.png supplied for visual style only. Original PNGs and optimized WebP versions are in public/brand.

Prompt brief, login: portrait 4:5 flat 2D Indonesian branch administrator comparing a paper receipt and ledger, green/mint/coral palette, white breathing space, restrained tonal depth, no text, logos, floating UI, glossy 3D or invented metrics.

Prompt brief, banner: wide 3:1 flat 2D receipt tray, binder and pencil, forest green/sage with coral accent, white background, compact grounded composition, no text, dashboard windows or invented metrics.

Integration: scripts/build-ui.mjs checks baseline hashes, then selects an editable ui/ override when present. Feature source is in ui/ and public/brand; generated public/portal.html must not be manually edited.

Preview: /visual-preview.html is an explicitly labelled visual gallery and contains no transaction data or authentication bypass. Full authenticated workflow verification still depends on the unfinished backend integration.

Workspace refresh: public/brand/workspace.css bridges the existing component tokens to forest green, warm paper and mint. Flat cards have thin borders; elevation is reserved for popovers and dialogs. Danger and warning colors retain their meanings. Mobile input layouts stack at tablet widths; table containers keep horizontal scrolling and controls retain visible keyboard focus. Reduced motion covers the whole workspace.

The generated /workspace-preview.html reuses the real menu markup, strips all application scripts and inline event handlers, and only enables preview navigation and the two input tabs. Saving and file uploads are disabled. It makes no authenticated application requests. This is a visual preview, not a completed backend demo.

Blue revision verification: 12 distinct SVG menu illustrations, custom preview select popovers with keyboard navigation, electricity detail/control tab switching, and selectable page size. Preview navigation is grouped into Tax, Administrator and Cabang. Refresh and data pagination remain unavailable without backend integration; no sample records or simulated successful saves were added. All 12 pages fit a 390px viewport.

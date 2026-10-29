# 连续步态生成提示词

使用内置 `image_gen`（透明背景），每种角色单独生成；没有使用 CLI 或外部 API。输入图 1 为对应的 `assets/pets/{clay,moss,zip}.webp` 角色设定，输入图 2 为 [walk-phase-guide.svg](walk-phase-guide.svg) 渲染出的 PNG，只约束逐帧姿势和次序。

最终选用这一轮带动作导引的生成结果，按完整角色边界提取，按站姿高度统一比例、头部水平锚点和脚底基线排成 1024 × 768 图集；保留生成素材的透明通道。原有四帧保留在旧图集中，运行时切换到独立的十二帧步态图集。

## 共用提示词

```text
Use case: stylized-concept. Production 12-frame walk-cycle sprite atlas.
Image 1: the mascot identity, palette and rendering style reference. Preserve that character.
Image 2: EXACT per-frame pose guide. This second image supplies the layout, the arm and leg positions and their order. Recreate the twelve poses in EXACT corresponding cells. Four columns by three rows, read left-to-right top-to-bottom.
Render the reference mascot over the pose guide, keeping its identity, head design and original body proportions. The gray and blue guide colors are only anatomical guides: REPLACE THEM with the mascot's original colors, materials and textures. Do not copy the guide's generic head or erase the mascot's antennae, ant abdomen or far arm. Both arms and both legs must be present.
CRITICAL: near leg is FORWARD in cell 1, directly under the hip in cell 4, BACKWARD in cell 7, lifted and passing in cell 10, then forward again by cell 12. The arm swings in the opposite direction to the same-side leg. Far leg and far arm take the opposite phase. Follow the guide's foot and knee placement in each cell precisely; do not reuse the same forward leg pose for all cells.
Same calm smile, same camera angle facing right, same head silhouette, same head size and same torso anchor in all cells. Head, torso and abdomen must not drift or change shape between frames. Compact steady walking, always at least one foot grounded, no running or jumping. The sequence must loop smoothly from frame 12 into 1.
Exactly twelve complete characters entirely inside evenly sized cells, including antennae. Match guide spacing and ground baseline, leave transparent margins. Output clean transparent background, no text, grid, labels, extra props, ground shadows or background. Landscape 4:3 canvas.
```

## 分角色追加

### clay

```text
Character material: Matte orange soft-clay/vinyl mascot, terracotta striped abdomen, dark brown eyes with cream sclera.
```

### moss

```text
Character material: Handmade wool felt mascot with cream head and mitten hands, stitched charcoal oval eyes, sage green torso and striped abdomen, lilac feet and antenna tips.
```

### zip

```text
Character material: Flat hand-inked navy/indigo mascot with off-white eyes, coral striped abdomen and butter-yellow hands, feet and antenna tips. Navy variable-width outlines.
```

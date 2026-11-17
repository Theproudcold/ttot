/**
 * 网格旋转角的归一化。
 *
 * 单独成模块：工程契约（projectSnapshot）与校验层（projectSnapshotSchema）
 * 都需要它，若放在任一侧都会形成反向 import 环。
 */

/** 把任意角度归一化到 [0, 360)；非有限值按 0 处理。 */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) {
    return 0;
  }

  return ((degrees % 360) + 360) % 360;
}

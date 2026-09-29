import os
import time

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from desk.models import OffsetSubmission, TraceLog

# 在途 = 排队候审（pending）或审中（processing），任一命中即禁止同刀再开。
IN_FLIGHT_STATUSES = (
    OffsetSubmission.Status.PENDING,
    OffsetSubmission.Status.PROCESSING,
)


def normalize_tool_code(raw: str) -> str:
    """同一把刀的不同写法（空白/大小写）归一，便于在途比对与按刀号回看。"""
    return (raw or "").strip().upper()


def evaluate_verdict(offset_um: int) -> str:
    if abs(offset_um) <= settings.OFFSET_TOLERANCE_UM:
        return OffsetSubmission.Verdict.PASS
    return OffsetSubmission.Verdict.FAIL


def apply_verdict(submission: OffsetSubmission) -> None:
    submission.verdict = evaluate_verdict(submission.offset_um)
    submission.status = OffsetSubmission.Status.DONE
    submission.reviewed_at = timezone.now()
    submission.save(
        update_fields=["verdict", "status", "reviewed_at"],
    )


class GateRejected(Exception):
    """同刀在途未清，整笔拒收；携带命中的全部冲突编号。"""

    def __init__(self, tool_code: str, conflict_ids: list[int]):
        self.tool_code = tool_code
        self.conflict_ids = conflict_ids
        super().__init__(
            f"刀具 {tool_code} 仍有未办结单 {conflict_ids}，禁止再开第二张"
        )


def in_flight_for_tool(tool_code: str) -> list[OffsetSubmission]:
    return list(
        OffsetSubmission.objects.filter(
            tool_code=tool_code,
            status__in=IN_FLIGHT_STATUSES,
        ).order_by("created_at", "id")
    )


def submit_through_gate(*, user, tool_code: str, offset_um: int) -> OffsetSubmission:
    """开单前先扫在途：命中即整笔拒收并点名冲突编号；全部办结才放行同刀再开。

    放行与拒收各自写入痕迹簿。同一刀号用 pg_advisory_xact_lock 串行化，
    防止两个并发请求同时扫到空在途而双双放行。
    """
    tc = normalize_tool_code(tool_code)
    if not tc:
        raise ValueError("刀具编号不能为空")

    conflicts: list[OffsetSubmission] = []
    with transaction.atomic():
        with connection.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [tc])
        conflicts = in_flight_for_tool(tc)
        if not conflicts:
            submission = OffsetSubmission.objects.create(
                tool_code=tc,
                offset_um=offset_um,
                submitted_by=user,
                status=OffsetSubmission.Status.PENDING,
            )
            TraceLog.objects.create(
                action=TraceLog.Action.ACCEPTED,
                tool_code=tc,
                offset_um=offset_um,
                conflict_ids=[],
                submission=submission,
                acted_by=user,
                detail="在途已清，放行开单",
            )
            return submission

    # 锁事务已结束（未插入新单）；拒收痕迹独立落簿，避免随回滚丢失。
    conflict_ids = [row.id for row in conflicts]
    TraceLog.objects.create(
        action=TraceLog.Action.REJECTED,
        tool_code=tc,
        offset_um=offset_um,
        conflict_ids=conflict_ids,
        acted_by=user,
        detail="在途未清，禁止同刀再开第二张",
    )
    raise GateRejected(tc, conflict_ids)


def processing_hold_seconds() -> float:
    """复核中停留时长：让「审中」状态可被观察（也仍占在途）。"""
    return float(os.environ.get("PROCESSING_HOLD_SECONDS", "5"))


def hold_in_processing() -> None:
    seconds = processing_hold_seconds()
    if seconds > 0:
        time.sleep(seconds)

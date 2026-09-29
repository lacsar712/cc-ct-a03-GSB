from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    class Role(models.TextChoices):
        MACHINIST = "machinist", "操作员"
        AUDITOR = "auditor", "复核员"

    role = models.CharField(
        max_length=20,
        choices=Role.choices,
        default=Role.MACHINIST,
    )

    @property
    def can_write(self) -> bool:
        return self.role == self.Role.MACHINIST


class OffsetSubmission(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "待复核"
        PROCESSING = "processing", "复核中"
        DONE = "done", "已完成"

    class Verdict(models.TextChoices):
        PASS = "合格", "合格"
        FAIL = "超差", "超差"

    tool_code = models.CharField(max_length=32, db_index=True)
    offset_um = models.IntegerField()
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    verdict = models.CharField(
        max_length=8,
        choices=Verdict.choices,
        blank=True,
        default="",
    )
    submitted_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="submissions",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            # 同一把刀在途（排队待复核 / 复核中）记录至多一条，
            # 全部办结后才允许同刀再开第二张。
            models.UniqueConstraint(
                fields=["tool_code"],
                condition=models.Q(status__in=["pending", "processing"]),
                name="uniq_open_submission_per_tool",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.tool_code} {self.offset_um}µm"


class ToolTrace(models.Model):
    """同刀开单痕迹簿：每张开单尝试（放行 / 拒收）留一条，可按刀号回看。"""

    class Action(models.TextChoices):
        ACCEPTED = "accepted", "放行"
        REJECTED = "rejected", "拒收"

    tool_code = models.CharField(max_length=32, db_index=True)
    action = models.CharField(max_length=16, choices=Action.choices, db_index=True)
    submission = models.ForeignKey(
        OffsetSubmission,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="traces",
    )
    conflict_ids = models.JSONField(default=list, blank=True)
    detail = models.CharField(max_length=255, blank=True, default="")
    actor = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="tool_traces",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]

    def __str__(self) -> str:
        return f"{self.tool_code} {self.get_action_display()}"

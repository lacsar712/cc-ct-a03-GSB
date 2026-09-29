import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("desk", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="ToolTrace",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("tool_code", models.CharField(db_index=True, max_length=32)),
                (
                    "action",
                    models.CharField(
                        choices=[("accepted", "放行"), ("rejected", "拒收")],
                        db_index=True,
                        max_length=16,
                    ),
                ),
                ("conflict_ids", models.JSONField(blank=True, default=list)),
                ("detail", models.CharField(blank=True, default="", max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                (
                    "actor",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="tool_traces",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "submission",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="traces",
                        to="desk.offsetsubmission",
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at", "-id"],
            },
        ),
        migrations.AddConstraint(
            model_name="offsetsubmission",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status__in", ["pending", "processing"])),
                fields=("tool_code",),
                name="uniq_open_submission_per_tool",
            ),
        ),
    ]

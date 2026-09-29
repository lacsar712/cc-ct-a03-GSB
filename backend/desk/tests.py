from django.test import TestCase

from desk.auth_utils import create_access_token, hash_password
from desk.models import OffsetSubmission, User
from desk.services import apply_verdict


def auth_headers(user):
    token = create_access_token(user)
    return {"Authorization": f"Bearer {token}"}


class SameToolGuardTests(TestCase):
    """同刀在途拦截端到端：拒收点名冲突编号，办结后才可再开，只读账号只能看。"""

    @classmethod
    def setUpTestData(cls):
        cls.machinist = User.objects.create(
            username="machinist",
            password=hash_password("machine123456"),
            role=User.Role.MACHINIST,
        )
        cls.auditor = User.objects.create(
            username="auditor",
            password=hash_password("audit123456"),
            role=User.Role.AUDITOR,
        )

    def api_client(self):
        from ninja.testing import TestClient

        from desk.api import api

        return TestClient(api)

    def test_open_reject_then_accept_after_done(self):
        client = self.api_client()
        h = auth_headers(self.machinist)

        # 乙刀先进候审区
        r1 = client.post("/submissions", json={"tool_code": "T02", "offset_um": 5}, headers=h)
        self.assertEqual(r1.status_code, 200, r1.content)
        first_id = r1.json()["id"]
        self.assertEqual(r1.json()["status"], "pending")

        # 立刻再投同刀：整笔拒收，且必须点名冲突编号
        r2 = client.post("/submissions", json={"tool_code": "T02", "offset_um": 8}, headers=h)
        self.assertEqual(r2.status_code, 409, r2.content)
        body = r2.json()
        self.assertEqual(body["tool_code"], "T02")
        self.assertEqual(body["conflict_ids"], [first_id])
        self.assertIn(str(first_id), body["detail"])
        # 拒收不得落单据
        self.assertEqual(OffsetSubmission.objects.filter(tool_code="T02").count(), 1)

        # 第一张进入审中（worker 已 claim、尚未出结论）期间，同刀再投仍须拒收
        OffsetSubmission.objects.filter(id=first_id).update(
            status=OffsetSubmission.Status.PROCESSING
        )
        r3 = client.post("/submissions", json={"tool_code": "T02", "offset_um": 8}, headers=h)
        self.assertEqual(r3.status_code, 409)
        self.assertEqual(r3.json()["conflict_ids"], [first_id])

        # 复核完成（办结）
        apply_verdict(OffsetSubmission.objects.get(id=first_id))
        self.assertEqual(
            OffsetSubmission.objects.get(id=first_id).status,
            OffsetSubmission.Status.DONE,
        )

        # 办结后再投：应收下
        r4 = client.post("/submissions", json={"tool_code": "T02", "offset_um": 3}, headers=h)
        self.assertEqual(r4.status_code, 200, r4.content)
        second_id = r4.json()["id"]
        self.assertNotEqual(second_id, first_id)

        # 历史出现旧单、在途清空为只剩新单
        m = client.get("/monitor?tool_code=T02", headers=h).json()
        self.assertEqual([x["id"] for x in m["history"]], [first_id])
        self.assertEqual([x["id"] for x in m["open"]], [second_id])

        # 痕迹簿可按刀号回看：放行两张 + 拒收两张，拒收均点名冲突编号
        actions = [(t["action"], t["conflict_ids"]) for t in m["traces"]]
        self.assertEqual(actions.count(("accepted", [])), 2)
        rejected = [c for a, c in actions if a == "rejected"]
        self.assertEqual(len(rejected), 2)
        self.assertTrue(all(c == [first_id] for c in rejected))

    def test_different_tools_coexist(self):
        client = self.api_client()
        h = auth_headers(self.machinist)
        self.assertEqual(
            client.post("/submissions", json={"tool_code": "T03", "offset_um": 1}, headers=h).status_code,
            200,
        )
        self.assertEqual(
            client.post("/submissions", json={"tool_code": "T04", "offset_um": 1}, headers=h).status_code,
            200,
        )

    def test_readonly_can_watch_but_not_submit(self):
        client = self.api_client()
        mh = auth_headers(self.machinist)
        ah = auth_headers(self.auditor)

        client.post("/submissions", json={"tool_code": "T05", "offset_um": 1}, headers=mh)

        # 只读账号能看监视台三块
        m = client.get("/monitor?tool_code=T05", headers=ah)
        self.assertEqual(m.status_code, 200, m.content)
        payload = m.json()
        self.assertIn("open", payload)
        self.assertIn("history", payload)
        self.assertIn("traces", payload)
        self.assertEqual(len(payload["open"]), 1)

        # 只读账号不能投
        r = client.post("/submissions", json={"tool_code": "T06", "offset_um": 1}, headers=ah)
        self.assertEqual(r.status_code, 403)

    def test_trace_isolated_by_tool(self):
        client = self.api_client()
        h = auth_headers(self.machinist)
        client.post("/submissions", json={"tool_code": "T07", "offset_um": 1}, headers=h)
        client.post("/submissions", json={"tool_code": "T07", "offset_um": 1}, headers=h)  # 拒收
        m = client.get("/monitor?tool_code=T99", headers=h).json()
        self.assertEqual(m["open"], [])
        self.assertEqual(m["history"], [])
        self.assertEqual(m["traces"], [])

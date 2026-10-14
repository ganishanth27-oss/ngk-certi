import io
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

os.environ["ADMIN_EMAIL"] = "admin@example.com"
os.environ["ADMIN_PASSWORD"] = "Admin123!"
import app as portal


class PortalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.test_db = Path(cls.tmp.name) / "test.sqlite3"
        portal.DB_PATH = cls.test_db
        portal.UPLOAD_DIR = Path(cls.tmp.name) / "uploads"
        portal.UPLOAD_DIR.mkdir()
        portal.app.config.update(TESTING=True, SECRET_KEY="test-session-secret")
        portal.init_db()

        db = sqlite3.connect(cls.test_db)
        cursor = db.execute(
            "INSERT INTO events(name,event_date,venue,description,status,created_at) VALUES(?,?,?,?,?,?)",
            ("Regression test event", "2026-10-07", "Test venue", "", "Active", portal.now_iso()),
        )
        cls.event_id = cursor.lastrowid
        people = [
            ("Test Participant One", "9876543210", "one@test.invalid"),
            ("Test Participant Two", "9876543211", "two@test.invalid"),
            ("Test Participant Three", "9876543212", "three@test.invalid"),
            ("Test Participant Four", "9876543213", "four@test.invalid"),
            ("Test Participant Five", "9876543214", "five@test.invalid"),
        ]
        for name, mobile, email in people:
            result = db.execute(
                "INSERT INTO participants(event_id,student_name,mobile,email,participation,certificate_id,created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (cls.event_id, name, mobile, email, "Participation", portal.certificate_code(), portal.now_iso()),
            )
            db.execute("INSERT INTO certificates(participant_id) VALUES(?)", (result.lastrowid,))
        db.commit()
        db.close()

        cls.client = portal.app.test_client()
        response = cls.client.post(
            "/api/login", json={"email": "admin@example.com", "password": "Admin123!"}
        )
        assert response.status_code == 200, response.get_data(as_text=True)
        cls.csrf = response.json["csrf"]
        cls.headers = {"X-CSRF-Token": cls.csrf}

    @classmethod
    def tearDownClass(cls):
        try:
            cls.tmp.cleanup()
        except Exception:
            pass

    def test_fresh_database_has_no_example_events_or_participants(self):
        original_path = portal.DB_PATH
        fresh_path = Path(self.tmp.name) / "fresh.sqlite3"
        portal.DB_PATH = fresh_path
        try:
            portal.init_db()
            db = sqlite3.connect(fresh_path)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM participants").fetchone()[0], 0)
            db.close()
        finally:
            portal.DB_PATH = original_path

    def test_admin_api_requires_login(self):
        client = portal.app.test_client()
        self.assertEqual(client.get("/api/admin/events").status_code, 401)

    def test_admin_lists_existing_records(self):
        events = self.client.get("/api/admin/events").json["events"]
        people = self.client.get("/api/admin/participants").json["participants"]
        self.assertEqual(len(events), 1)
        self.assertEqual(len(people), 5)

    def test_both_verification_fields_required_and_match(self):
        bad = self.client.post(
            "/api/verify", json={"mobile": "9876543210", "email": "wrong@test.invalid"}
        )
        self.assertEqual(bad.status_code, 404)
        good = self.client.post(
            "/api/verify", json={"mobile": "9876543210", "email": "one@test.invalid"}
        )
        self.assertEqual(good.status_code, 200)
        self.assertEqual(good.json["student_name"], "Test Participant One")
        self.assertEqual(len(good.json["certificates"]), 1)

    def test_certificate_download_is_generated_pdf(self):
        found = self.client.post(
            "/api/verify", json={"mobile": "9876543210", "email": "one@test.invalid"}
        ).json
        response = self.client.get(found["certificates"][0]["download_url"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/pdf")
        self.assertTrue(response.data.startswith(b"%PDF"))

    def test_csv_preview_and_duplicate_import_guard(self):
        upload = {
            "file": (
                io.BytesIO(b"Name,Mobile,Email,Participation\nNew Person,9876500000,new@testing.invalid,Workshop\n"),
                "people.csv",
            )
        }
        preview = self.client.post(
            "/api/admin/import/preview",
            data=upload,
            headers=self.headers,
            content_type="multipart/form-data",
        )
        self.assertEqual(preview.status_code, 200, preview.get_data(as_text=True))
        commit_body = {"event_id": self.event_id, "rows": preview.json["rows"]}
        first = self.client.post("/api/admin/import/commit", json=commit_body, headers=self.headers)
        second = self.client.post("/api/admin/import/commit", json=commit_body, headers=self.headers)
        self.assertEqual(first.json["imported"], 1)
        self.assertEqual(second.json["skipped"], 1)

        saved = self.client.get("/api/admin/participants?q=New+Person").json["participants"][0]
        updated = self.client.put(
            f"/api/admin/participants/{saved['id']}",
            json={
                "student_name": "Updated Participant",
                "mobile": saved["mobile"],
                "email": saved["email"],
                "event_id": self.event_id,
                "participation": "Updated details",
            },
            headers=self.headers,
        )
        self.assertEqual(updated.status_code, 200)

        logout = self.client.post("/api/logout", json={}, headers=self.headers)
        self.assertEqual(logout.status_code, 200)
        login = self.client.post(
            "/api/login", json={"email": "admin@example.com", "password": "Admin123!"}
        )
        self.assertEqual(login.status_code, 200)
        self.__class__.headers = {"X-CSRF-Token": login.json["csrf"]}
        people = self.client.get("/api/admin/participants?q=Updated+Participant").json["participants"]
        self.assertEqual(len(people), 1)
        self.assertEqual(people[0]["participation"], "Updated details")

    def test_xlsx_export(self):
        response = self.client.get("/api/admin/export?format=xlsx")
        self.assertEqual(response.status_code, 200)
        self.assertIn("spreadsheetml", response.mimetype)

    def test_pages_show_portal_branding(self):
        public = self.client.get("/").get_data(as_text=True)
        admin = self.client.get("/admin").get_data(as_text=True)
        self.assertIn("NGK Portal", public)
        self.assertIn("Nehru Grand Kacheri", public)
        self.assertIn("NGK Portal", admin)
        self.assertNotIn("Demo access", admin)
        self.assertNotIn("```", admin)

    def test_custom_image_template_upload_preview_and_pdf(self):
        # 1. Create a minimal valid PNG image
        from PIL import Image as PILImage
        img_buf = io.BytesIO()
        img = PILImage.new("RGB", (800, 600), color=(240, 244, 255))
        img.save(img_buf, format="PNG")
        img_buf.seek(0)

        # 2. Upload template to event
        field_positions = {
            "participant_name": {"enabled": True, "x": 0.5, "y": 0.6, "size": 28, "color": "#0d47a1", "align": "center"},
            "event_name": {"enabled": True, "x": 0.5, "y": 0.45, "size": 18, "color": "#1565c0", "align": "center"},
            "event_date": {"enabled": True, "x": 0.5, "y": 0.35, "size": 12, "color": "#37474f", "align": "center"},
            "certificate_id": {"enabled": True, "x": 0.08, "y": 0.05, "size": 9, "color": "#78909c", "align": "left"},
        }
        upload_data = {
            "file": (img_buf, "template.png"),
            "field_positions": portal.json.dumps(field_positions),
            "title": "CUSTOM TITLE",
        }
        res = self.client.post(
            f"/api/admin/templates/{self.event_id}",
            data=upload_data,
            headers=self.headers,
            content_type="multipart/form-data",
        )
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        self.assertTrue(res.json["uploaded"])
        self.assertIsNotNone(res.json["template_image_url"])

        # 3. Check admin template endpoint
        tpl_info = self.client.get(f"/api/admin/templates/{self.event_id}", headers=self.headers)
        self.assertEqual(tpl_info.status_code, 200)
        self.assertTrue(tpl_info.json["uploaded"])
        self.assertEqual(tpl_info.json["field_positions"]["participant_name"]["size"], 28)

        # 4. Check template image download endpoint (public & admin)
        img_res = self.client.get(f"/api/templates/{self.event_id}/image")
        self.assertEqual(img_res.status_code, 200)
        self.assertEqual(img_res.mimetype, "image/png")

        # 5. Check certificate HTML preview page contains custom template wrapper
        verify_res = self.client.post(
            "/api/verify", json={"mobile": "9876543210", "email": "one@test.invalid"}
        ).json
        token = verify_res["certificates"][0]["token"]
        cert_page = self.client.get(f"/certificate/{token}")
        self.assertEqual(cert_page.status_code, 200)
        cert_html = cert_page.get_data(as_text=True)
        self.assertIn("custom-certificate-wrap", cert_html)
        self.assertIn("Test Participant One", cert_html)
        self.assertIn("Regression test event", cert_html)
        # Verify it did NOT inject default template title/org into custom template
        self.assertNotIn("paper-border", cert_html)

        # 6. Check generated PDF download
        pdf_res = self.client.get(verify_res["certificates"][0]["download_url"])
        self.assertEqual(pdf_res.status_code, 200)
        self.assertEqual(pdf_res.mimetype, "application/pdf")
        self.assertTrue(pdf_res.data.startswith(b"%PDF"))

        # 7. Remove/delete custom template and verify revert to default design
        del_res = self.client.delete(f"/api/admin/templates/{self.event_id}", headers=self.headers)
        self.assertEqual(del_res.status_code, 200)
        tpl_reverted = self.client.get(f"/api/admin/templates/{self.event_id}", headers=self.headers).json
        self.assertFalse(tpl_reverted["uploaded"])
        self.assertIsNone(tpl_reverted["template_image_url"])

        # HTML preview should now show the default certificate paper
        cert_page2 = self.client.get(f"/certificate/{token}")
        self.assertIn("certificate-paper", cert_page2.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()

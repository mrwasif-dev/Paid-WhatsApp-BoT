const axios = require('axios');
const FormData = require('form-data');
const { fromBuffer } = require('file-type');

// Upload to Catbox.moe
// Userhash not strictly required for anonymous uploads, but useful if we want to manage them later.
async function wasi_uploadToCatbox(buffer) {
    try {
        const type = await fromBuffer(buffer);
        const ext = type ? type.ext : 'bin';
        const bodyForm = new FormData();

        bodyForm.append('reqtype', 'fileupload');
        bodyForm.append('userhash', ''); // Anonymous upload
        bodyForm.append('fileToUpload', buffer, `file.${ext}`);

        const response = await axios.post('https://catbox.moe/user/api.php', bodyForm, {
            headers: bodyForm.getHeaders(),
        });

        if (response.data && response.data.startsWith('https://')) {
            return response.data;
        } else {
            throw new Error(response.data); // Usually returns error message string
        }
    } catch (error) {
        console.error('Catbox Upload Error:', error.message);
        return null; // Fail gracefully
    }
}

module.exports = { wasi_uploadToCatbox };

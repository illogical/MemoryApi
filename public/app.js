document.addEventListener('DOMContentLoaded', () => {
    const queueContainer = document.getElementById('queue-container');
    let categories = [];
    let allTags = [];
    let serverStatus = { vector: false, graph: false, sql: false, model: false };

    // Fetch initial data
    Promise.all([
        fetch('/api/review/categories').then(res => res.json()),
        fetch('/api/review/tags').then(res => res.json()),
        fetch('/api/review/queue').then(res => res.json()),
        fetchSuggestedTags()
    ]).then(([cats, tags, queue]) => {
        categories = cats;
        allTags = tags;
        renderQueue(queue);
    }).catch(err => {
        console.error('Error loading data:', err);
        queueContainer.innerHTML = '<div class="error">Failed to load data. Please try again later.</div>';
    });

    async function fetchSuggestedTags(threshold = 5) {
        try {
            const res = await fetch(`/api/memories/suggested-tags?threshold=${threshold}`);
            if (!res.ok) return;
            const tags = await res.json();
            renderSuggestedTags(tags);
        } catch (err) {
            console.error('Error fetching suggested tags:', err);
        }
    }

    function renderSuggestedTags(tags) {
        const section = document.getElementById('suggested-tags-section');
        const list = document.getElementById('suggested-tags-list');
        
        if (!tags || tags.length === 0) {
            section.style.display = 'none';
            return;
        }

        section.style.display = 'block';
        list.innerHTML = '';

        tags.forEach(tag => {
            const pill = document.createElement('div');
            pill.className = 'tag-pill';
            pill.innerHTML = `
                <span>${tag.TagText}</span>
                <span class="tag-count">${tag.Count}</span>
                <span class="dismiss-tag" title="Dismiss suggestion">×</span>
            `;
            pill.title = `Suggested ${tag.Count} times`;
            
            const dismissBtn = pill.querySelector('.dismiss-tag');
            dismissBtn.onclick = async (e) => {
                e.stopPropagation();
                if (await dismissSuggestedTag(tag.ID)) {
                    pill.remove();
                    if (list.children.length === 0) {
                        section.style.display = 'none';
                    }
                }
            };
            
            list.appendChild(pill);
        });
    }

    async function dismissSuggestedTag(id) {
        try {
            const res = await fetch(`/api/memories/suggested-tags/${id}`, {
                method: 'DELETE'
            });
            return res.ok;
        } catch (err) {
            console.error('Error dismissing tag:', err);
            return false;
        }
    }

    // Check status independently so UI loads fast
    fetchStatus();

    async function fetchWithTimeout(resource, options = {}) {
        const { timeout = 8000 } = options;
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    }

    // Refresh Button Logic
    const refreshBtn = document.getElementById('refresh-status-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            const svg = refreshBtn.querySelector('svg');
            svg.classList.add('spin');
            refreshBtn.disabled = true;
            await fetchStatus();
            svg.classList.remove('spin');
            refreshBtn.disabled = false;
        });
    }

    async function fetchStatus() {
        const timeout = 5000; // 5 second timeout for status checks

        // Create independent promises for each status check
        const vectorPromise = fetchWithTimeout('/api/status/vector', { timeout })
            .then(res => res.json())
            .then(data => {
                // Update Vector UI immediately
                serverStatus.vector = data.active;
                updateStatusUI('vector-status', data);
            })
            .catch(err => {
                console.error('Error fetching vector status:', err);
                serverStatus.vector = false;
                updateStatusUI('vector-status', { active: false }, true);
            });

        const graphPromise = fetchWithTimeout('/api/status/graph', { timeout })
            .then(res => res.json())
            .then(data => {
                // Update Graph UI immediately
                serverStatus.graph = data.active;
                updateStatusUI('graph-status', data);
            })
            .catch(err => {
                console.error('Error fetching graph status:', err);
                serverStatus.graph = false;
                updateStatusUI('graph-status', { active: false }, true);
            });

        const sqlPromise = fetchWithTimeout('/api/status/sql', { timeout })
            .then(res => res.json())
            .then(data => {
                // Update SQL UI immediately
                serverStatus.sql = data.active;
                updateStatusUI('sql-status', data);
            })
            .catch(err => {
                console.error('Error fetching SQL status:', err);
                serverStatus.sql = false;
                updateStatusUI('sql-status', { active: false }, true);
            });

        const modelPromise = fetchWithTimeout('/api/status/model-provider', { timeout })
            .then(res => res.json())
            .then(data => {
                // Update Model UI immediately
                serverStatus.model = data.active;
                updateStatusUI('model-status', data);
            })
            .catch(err => {
                console.error('Error fetching model status:', err);
                serverStatus.model = false;
                updateStatusUI('model-status', { active: false }, true);
            });

        // Wait for all to settle before finishing (to stop spinner)
        await Promise.allSettled([vectorPromise, graphPromise, sqlPromise, modelPromise]);

        // Update global buttons after both checks allow consistent state
        updateCommitButtons();
    }

    function updateStatusUI(elementId, status, error = false) {
        const el = document.getElementById(elementId);
        const indicator = el.querySelector('.status-dot');
        const text = el.querySelector('.pill-value');

        // Reset classes
        indicator.className = 'status-dot';

        if (error || !status.active) {
            indicator.classList.add('error'); // Red dot
            text.textContent = `Not Active`;
        } else {
            indicator.classList.add('active'); // Green dot
            
            if (elementId === 'model-status') {
                // Special formatting for model provider
                const provider = status.provider || 'LLM';
                const model = status.model || 'Unknown';
                text.textContent = `${provider}: ${model}`;
                text.title = `Host: ${status.host}\nAvailable: ${status.availableModels?.join(', ') || 'None'}`;
            } else {
                const count = status.count !== undefined ? status.count : '?';
                let unit = 'Records';
                if (elementId.includes('graph')) unit = 'Nodes';
                if (elementId.includes('sql')) unit = 'History';
                text.textContent = `${count} ${unit}`;
            }
        }
    }

    // Correct Implementation of updateCommitButtons without cloning
    function updateCommitButtons() {
        const buttons = document.querySelectorAll('.btn-commit');
        const isActive = serverStatus.vector && serverStatus.graph && serverStatus.sql && serverStatus.model;

        buttons.forEach(btn => {
            if (!isActive) {
                btn.classList.add('btn-disabled');
                btn.title = "Server unavailable. Click to retry.";

                if (!btn.querySelector('.status-icon-btn')) {
                    const icon = document.createElement('span');
                    icon.className = 'status-icon-btn';
                    btn.appendChild(icon);
                }
            } else {
                btn.classList.remove('btn-disabled');
                btn.classList.remove('btn-loading');
                btn.title = "";
                const icon = btn.querySelector('.status-icon-btn');
                if (icon) icon.remove();
            }
        });
    }

    function renderQueue(queue) {
        queueContainer.innerHTML = '';

        if (queue.length === 0) {
            queueContainer.innerHTML = '<div class="empty-queue">No memories in the review queue.</div>';
            return;
        }

        queue.forEach(item => {
            const card = createMemoryCard(item);
            queueContainer.appendChild(card);
        });

        // Initial button state check
        updateCommitButtons();
    }

    function createMemoryCard(item) {
        const card = document.createElement('div');
        card.className = 'memory-card';
        card.dataset.id = item.id;

        // Meta bar (top-right) showing model and timestamp
        const metaBar = document.createElement('div');
        metaBar.className = 'memory-meta';

        if (item.Model) {
            const modelDisplay = document.createElement('div');
            modelDisplay.className = 'memory-model';
            modelDisplay.textContent = item.Model;
            metaBar.appendChild(modelDisplay);
        }

        // Creation date display (converted to EST/EDT)
        const dateDisplay = document.createElement('div');
        dateDisplay.className = 'memory-date';
        const createdDate = new Date(item.addedAt);
        // Convert UTC to Eastern Time (handles EST/EDT automatically)
        const easternDateTime = createdDate.toLocaleString('en-US', { 
            timeZone: 'America/New_York',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true // <-- 12-hour format with AM/PM
        });
        // Format as YYYY-MM-DD HH:MM:SS AM/PM
        const [datePart, timePart] = easternDateTime.split(', ');
        const [month, day, year] = datePart.split('/');
        dateDisplay.textContent = `${year}-${month}-${day} ${timePart}`;
        metaBar.appendChild(dateDisplay);

        card.appendChild(metaBar);

        // Content
        const contentGroup = createFormGroup('Content', 'textarea', item.Content);
        const descriptionGroup = createFormGroup('Description (Summary)', 'textarea', item.Description);

        // Category
        const categoryGroup = document.createElement('div');
        categoryGroup.className = 'form-group';
        const catLabel = document.createElement('label');
        catLabel.textContent = 'Category';
        const catSelect = document.createElement('select');
        categories.forEach(cat => {
            const option = document.createElement('option');
            option.value = cat;
            option.textContent = cat;
            if (cat === item.Category) option.selected = true;
            catSelect.appendChild(option);
        });
        categoryGroup.appendChild(catLabel);
        categoryGroup.appendChild(catSelect);

        // Tags
        const tagsGroup = document.createElement('div');
        tagsGroup.className = 'form-group';
        const tagsLabel = document.createElement('label');
        tagsLabel.textContent = 'Tags';
        const tagsContainer = document.createElement('div');
        tagsContainer.className = 'tags-container';

        // Render existing tags
        let currentTags = [...(item.Tags || [])];
        renderTags(tagsContainer, currentTags);

        // Tag Input with Autocomplete
        const tagInputWrapper = document.createElement('div');
        tagInputWrapper.className = 'tag-input-wrapper';
        const tagInput = document.createElement('input');
        tagInput.type = 'text';
        tagInput.placeholder = 'Add tag...';
        tagInputWrapper.appendChild(tagInput);

        setupAutocomplete(tagInput, allTags, (newTag) => {
            if (!currentTags.includes(newTag)) {
                currentTags.push(newTag);
                renderTags(tagsContainer, currentTags);
            }
            tagInput.value = '';
        });

        // Handle manual tag entry (Enter key)
        tagInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = tagInput.value.trim();
                if (val && !currentTags.includes(val)) {
                    currentTags.push(val);
                    renderTags(tagsContainer, currentTags);
                    tagInput.value = '';
                }
            }
        });

        tagsGroup.appendChild(tagsLabel);
        tagsGroup.appendChild(tagsContainer);
        tagsGroup.appendChild(tagInputWrapper);

        // Seed data checkbox (now inline with actions)
        const checkboxContainer = document.createElement('div');
        checkboxContainer.className = 'memory-seed-checkbox';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `seed-checkbox-${item.id}`;
        checkbox.checked = false;
        const checkboxLabel = document.createElement('label');
        checkboxLabel.htmlFor = `seed-checkbox-${item.id}`;
        checkboxLabel.textContent = 'Save to seed';
        checkboxContainer.appendChild(checkbox);
        checkboxContainer.appendChild(checkboxLabel);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'actions';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-save';
        saveBtn.textContent = 'Save Changes';
        saveBtn.onclick = () => {
            const memoryData = {
                Content: contentGroup.querySelector('textarea').value,
                Description: descriptionGroup.querySelector('textarea').value,
                Category: catSelect.value,
                Tags: currentTags
            };
            const saveToSeed = checkbox.checked;
            saveAndOptionallyCommit(item.id, memoryData, saveToSeed, false);
        };

        const commitBtn = document.createElement('button');
        commitBtn.className = 'btn-commit';
        commitBtn.textContent = 'Add Memory';
        commitBtn.onclick = async () => {
            // Check global server status
            if (!serverStatus.vector || !serverStatus.graph) {
                // Retry logic if disabled
                commitBtn.classList.add('btn-loading');
                await fetchStatus();
                // Brief delay for visual feedback, then remove loading
                setTimeout(() => commitBtn.classList.remove('btn-loading'), 500);
                return;
            }

            // Normal commit logic
            const memoryData = {
                Content: contentGroup.querySelector('textarea').value,
                Description: descriptionGroup.querySelector('textarea').value,
                Category: catSelect.value,
                Tags: currentTags
            };
            const saveToSeed = checkbox.checked;
            // Auto-save before commit to ensure latest state is used
            await saveAndOptionallyCommit(item.id, memoryData, saveToSeed, false);
            commitMemory(item.id);
        };

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-delete';
        deleteBtn.textContent = 'Delete';
        deleteBtn.onclick = () => deleteMemory(item.id);

        actions.appendChild(checkboxContainer);
        actions.appendChild(deleteBtn);
        actions.appendChild(saveBtn);
        actions.appendChild(commitBtn);

        card.appendChild(contentGroup);
        card.appendChild(descriptionGroup);
        card.appendChild(categoryGroup);
        card.appendChild(tagsGroup);
        card.appendChild(actions);

        // Helper to re-render tags inside the container
        function renderTags(container, tags) {
            container.innerHTML = '';
            tags.forEach(tag => {
                const tagElem = document.createElement('span');
                tagElem.className = 'tag';
                tagElem.textContent = tag;
                const removeSpan = document.createElement('span');
                removeSpan.className = 'remove-tag';
                removeSpan.textContent = '×';
                removeSpan.onclick = () => {
                    currentTags = currentTags.filter(t => t !== tag);
                    renderTags(container, currentTags);
                };
                tagElem.appendChild(removeSpan);
                container.appendChild(tagElem);
            });
        }

        return card;
    }

    function createFormGroup(labelText, inputType, value) {
        const group = document.createElement('div');
        group.className = 'form-group';
        const label = document.createElement('label');
        label.textContent = labelText;
        const input = document.createElement(inputType);
        input.value = value || '';
        group.appendChild(label);
        group.appendChild(input);
        return group;
    }

    function setupAutocomplete(input, options, onSelect) {
        let currentFocus;

        input.addEventListener('input', function (e) {
            const val = this.value;
            closeAllLists();
            if (!val) return false;
            currentFocus = -1;

            const list = document.createElement('div');
            list.setAttribute('id', this.id + 'autocomplete-list');
            list.setAttribute('class', 'autocomplete-items');
            this.parentNode.appendChild(list);

            const matches = options.filter(opt => opt.toLowerCase().includes(val.toLowerCase()));

            matches.forEach(match => {
                const item = document.createElement('div');
                // Highlight match
                const regex = new RegExp(`(${val})`, 'gi');
                item.innerHTML = match.replace(regex, '<strong>$1</strong>');
                item.innerHTML += `<input type='hidden' value='${match}'>`;
                item.addEventListener('click', function (e) {
                    onSelect(this.getElementsByTagName('input')[0].value);
                    closeAllLists();
                });
                list.appendChild(item);
            });
        });

        input.addEventListener('keydown', function (e) {
            let x = document.getElementById(this.id + 'autocomplete-list');
            if (x) x = x.getElementsByTagName('div');
            if (e.keyCode == 40) { // Down
                currentFocus++;
                addActive(x);
            } else if (e.keyCode == 38) { // Up
                currentFocus--;
                addActive(x);
            } else if (e.keyCode == 13) { // Enter
                e.preventDefault();
                if (currentFocus > -1) {
                    if (x) x[currentFocus].click();
                }
            }
        });

        function addActive(x) {
            if (!x) return false;
            removeActive(x);
            if (currentFocus >= x.length) currentFocus = 0;
            if (currentFocus < 0) currentFocus = (x.length - 1);
            x[currentFocus].classList.add('autocomplete-active');
            x[currentFocus].style.backgroundColor = "#e9e9e9";
        }

        function removeActive(x) {
            for (let i = 0; i < x.length; i++) {
                x[i].classList.remove('autocomplete-active');
                x[i].style.backgroundColor = "#fff";
            }
        }

        function closeAllLists(elmnt) {
            const x = document.getElementsByClassName('autocomplete-items');
            for (let i = 0; i < x.length; i++) {
                if (elmnt != x[i] && elmnt != input) {
                    x[i].parentNode.removeChild(x[i]);
                }
            }
        }

        document.addEventListener('click', function (e) {
            closeAllLists(e.target);
        });
    }

    async function saveAndOptionallyCommit(id, data, saveToSeed = false, showAlert = true) {
        try {
            // Save to review queue
            const res = await fetch(`/api/review/queue/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (!res.ok) {
                showNotification('Failed to update memory.', 'error');
                return false;
            }

            if (!saveToSeed) {
                if(showAlert) {
                    showNotification('Memory updated successfully!', 'success');
                }
                return true;
            }

            // Save to seed data
            try {
                const seedSuccess = await addSeedMemory(data);

                if (!seedSuccess) {
                    showNotification('Memory saved to review queue, but failed to save to seed data.', 'error');
                    return true; // Review queue save succeeded
                }

                if (showAlert) {
                    showNotification('Memory saved and added to seed data!', 'success');
                }
            } catch (err) {
                console.error('Error saving to seed data:', err);
                showNotification('Memory saved to review queue, but seed save failed.', 'error');
                // Review queue save succeeded
            }

            return true;
        } catch (err) {
            console.error(err);
            showNotification('Error updating memory.', 'error');
            return false;
        }
    }


    async function addSeedMemory(data)
    {
        const seedRes = await fetch('/api/seeds/memories', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: data.Content,
                        description: data.Description,
                        category: data.Category,
                        tags: data.Tags
                    })
                });

        return seedRes.ok;
    }
    

    function showNotification(message, type = 'success') {
        const notification = document.createElement('div');
        notification.className = `seed-notification ${type === 'error' ? 'error' : ''}`;
        notification.textContent = message;
        document.body.appendChild(notification);

        // Auto-remove after 3 seconds
        setTimeout(() => {
            notification.remove();
        }, 3000);
    }

    async function saveMemory(id, data, showAlert = true) {
        // Legacy function for backwards compatibility
        return saveAndOptionallyCommit(id, data, false, showAlert);
    }

    async function commitMemory(id) {
        if (!confirm('Are you sure you want to add this memory to the database?')) return;
        try {
            const res = await fetch(`/api/review/commit/${id}`, {
                method: 'POST'
            });
            if (res.ok) {
                alert('Memory added to database!');
                // Remove card from UI
                const card = document.querySelector(`.memory-card[data-id="${id}"]`);
                if (card) card.remove();

                // Check if empty
                if (document.querySelectorAll('.memory-card').length === 0) {
                    queueContainer.innerHTML = '<div class="empty-queue">No memories in the review queue.</div>';
                }
            } else {
                alert('Failed to commit memory.');
            }
        } catch (err) {
            console.error(err);
            alert('Error committing memory.');
        }
    }

    async function deleteMemory(id) {
        if (!confirm('Are you sure you want to delete this memory?')) return;
        try {
            const res = await fetch(`/api/review/queue/${id}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                const card = document.querySelector(`.memory-card[data-id="${id}"]`);
                if (card) card.remove();
                // Check if empty
                if (document.querySelectorAll('.memory-card').length === 0) {
                    queueContainer.innerHTML = '<div class="empty-queue">No memories in the review queue.</div>';
                }
            } else {
                alert('Failed to delete memory.');
            }
        } catch (err) {
            console.error(err);
            alert('Error deleting memory.');
        }
    }
});

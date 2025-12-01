document.addEventListener('DOMContentLoaded', () => {
    const queueContainer = document.getElementById('queue-container');
    let categories = [];
    let allTags = [];

    // Fetch initial data
    Promise.all([
        fetch('/api/review/categories').then(res => res.json()),
        fetch('/api/review/tags').then(res => res.json()),
        fetch('/api/review/queue').then(res => res.json())
    ]).then(([cats, tags, queue]) => {
        categories = cats;
        allTags = tags;
        renderQueue(queue);
    }).catch(err => {
        console.error('Error loading data:', err);
        queueContainer.innerHTML = '<div class="error">Failed to load data. Please try again later.</div>';
    });

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
    }

    function createMemoryCard(item) {
        const card = document.createElement('div');
        card.className = 'memory-card';
        card.dataset.id = item.id;

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

        // Actions
        const actions = document.createElement('div');
        actions.className = 'actions';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-save';
        saveBtn.textContent = 'Save Changes';
        saveBtn.onclick = () => saveMemory(item.id, {
            Content: contentGroup.querySelector('textarea').value,
            Description: descriptionGroup.querySelector('textarea').value,
            Category: catSelect.value,
            Tags: currentTags
        });

        const commitBtn = document.createElement('button');
        commitBtn.className = 'btn-commit';
        commitBtn.textContent = 'Add Memory';
        commitBtn.onclick = async () => {
            // Auto-save before commit to ensure latest state is used
            await saveMemory(item.id, {
                Content: contentGroup.querySelector('textarea').value,
                Description: descriptionGroup.querySelector('textarea').value,
                Category: catSelect.value,
                Tags: currentTags
            }, false); // false = don't alert on save
            commitMemory(item.id);
        };

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-delete';
        deleteBtn.textContent = 'Delete';
        deleteBtn.onclick = () => deleteMemory(item.id);

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
        
        input.addEventListener('input', function(e) {
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
                item.addEventListener('click', function(e) {
                    onSelect(this.getElementsByTagName('input')[0].value);
                    closeAllLists();
                });
                list.appendChild(item);
            });
        });

        input.addEventListener('keydown', function(e) {
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

    async function saveMemory(id, data, showAlert = true) {
        try {
            const res = await fetch(`/api/review/queue/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (res.ok) {
                if (showAlert) alert('Memory updated successfully!');
            } else {
                alert('Failed to update memory.');
            }
        } catch (err) {
            console.error(err);
            alert('Error updating memory.');
        }
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
